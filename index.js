const {
    Worker,
    isMainThread,
    parentPort,
    workerData
} = require('worker_threads');
const fs = require('fs');
const Jimp = require('jimp');
let {
    Bitmap,
    ImageRunner,
    ShapeTypes,
    ShapeJsonExporter
} = require('geometrizejs');

require('@g-js-api/g.js');

console.time('finished in');

let min_scale = 0.15; // smallest scaled objects to omit from level (for optimization purposes)

function rgb2hsv(r, g, b) {
    let rabs, gabs, babs, rr, gg, bb, h, s, v, diff, diffc, percentRoundFn;
    rabs = r / 255;
    gabs = g / 255;
    babs = b / 255;
    v = Math.max(rabs, gabs, babs),
        diff = v - Math.min(rabs, gabs, babs);
    diffc = c => (v - c) / 6 / diff + 1 / 2;
    percentRoundFn = num => Math.round(num * 100) / 100;
    if (diff == 0) {
        h = s = 0;
    } else {
        s = diff / v;
        rr = diffc(rabs);
        gg = diffc(gabs);
        bb = diffc(babs);

        if (rabs === v) {
            h = bb - gg;
        } else if (gabs === v) {
            h = (1 / 3) + rr - bb;
        } else if (babs === v) {
            h = (2 / 3) + gg - rr;
        }
        if (h < 0) {
            h += 1;
        } else if (h > 1) {
            h -= 1;
        }
    }
    let [hue, saturation, brightness] = [Math.round(h * 360), percentRoundFn(s * 100) / 100, percentRoundFn(v * 100) / 100]
    return `${hue}a${saturation}a${brightness}a0a0`;
}

let DRAW_SCALE = 3;

let col = unknown_c();
col.set(rgb(255, 0, 0));

let objects = [];

let saved = 0;

let circle = (x, y, radius, rgba, zo) => {
    let str = rgb2hsv(...rgba.slice(0, -1));

    let o = {
        OBJ_ID: 1764,
        X: x / DRAW_SCALE,
        Y: y / DRAW_SCALE,
        SCALING: radius / DRAW_SCALE / 4,
        HVS_ENABLED: 1,
        HVS: str,
        COLOR: col,
        Z_ORDER: zo,
        GROUPS: group(3),
		DONT_FADE: true,
		DONT_ENTER: true
    };

    return o
}

let readfile = (filename) => {
    return new Promise((resolve) => {
        let output = [];

        const readStream = fs.createReadStream(filename);

        readStream.on('data', function(chunk) {
            output.push(chunk);
        });

        readStream.on('end', function() {
            resolve(Buffer.concat(output));
        });
    })
}

let image = async (buf) => {
    let zo = 0;
    let objects = [];
    let image = await Jimp.read(buf);
    image = image.flip(false, true);
    const bitmap = Bitmap.createFromByteArray(image.bitmap.width,
        image.bitmap.height, image.bitmap.data)
    const runner = new ImageRunner(bitmap)
    const options = {
        shapeTypes: [ShapeTypes.CIRCLE],
        candidateShapesPerStep: 300,
        shapeMutationsPerStep: 300,
        alpha: 255
    }
    const iterations = 2000;
    const shapes = []
    for (let i = 0; i < iterations; i++) {
        let x = JSON.parse(ShapeJsonExporter.exportShapes(runner.step(options)));
        let c = circle(...x.data, x.color, zo);
        objects.push(c);
        zo++;
    }
    return objects;
};

const zeroPad = (str, length) => '0'.repeat(Math.max(0, length - str.toString().length)) + str.toString();
let json_data = { // tells the program if and how to load JSON files/write to them
    json: false, // use "true" to load an existing JSON file, otherwise "false"
    filepath: "./export.json" // filepath to read from/write to
};


(async () => {
    if (!json_data.json) {
        let frame = 0;
        let max_frames = 45; // amount of frames 
        let folder_name = "my_folder"; // folder name where frames are stored
        max_frames++;

        let processFrameAsync = async (frame) => {
            let file = await readfile(`${folder_name}/${zeroPad(frame, 4)}.png`);
            let frame_data = await image(file);
            frame++;
            return {
                frame_data,
                current_frame: frame - 1
            };
        }

        let threads_am = require("os").cpus().length;

        function calculateThreads(totalFrames, currentIteration) {
            const remainingFrames = totalFrames - currentIteration * threads_am;

            if (remainingFrames > 0) {
                return Math.min(threads_am, remainingFrames);
            } else {
                return 0;
            }
        }

        let offset_x = 0;

        function createWorker(frameNumber) {
            return new Promise((resolve, reject) => {
                let objects_tmp;
                const worker = new Worker(__filename, {
                    workerData: frameNumber
                });

                worker.on('message', (message) => {
                    console.log(`frame ${message.current_frame} done`);
                    offset_x = message.current_frame * (250 * 3);
                    objects_tmp = message.frame_data;
                });

                worker.on('error', (error) => {
                    console.error(`Error in worker: ${error}`);
                });

                worker.on('exit', (code) => {
                    if (code !== 0) {
                        reject(`Worker stopped with exit code ${code}`);
                    }
                    resolve({
                        objects_tmp,
                        offset_x
                    });
                });
            });
        }

        let save_cleanup = () => {
            fs.writeFileSync('export.json', JSON.stringify({
                test: 1,
                scale: DRAW_SCALE,
                objects,
            }));

            console.log('saved objects:', saved);
            $.exportToSavefile({
                info: true
            }); // Uncomment and replace with your actual code
            console.timeEnd('finished in');
        }

        let buildup = 0;
        if (isMainThread) {
            let iterations_left = max_frames;
            let curr_iter = 0;
            while (iterations_left > 0) {
				console.time(`batch ${curr_iter + 1}`)
                let threads_to_use = calculateThreads(max_frames, curr_iter);
                iterations_left -= threads_to_use;

                let pool = [];
                for (let i = 0; i < threads_to_use; i++) {
                    pool.push(createWorker(buildup));
                    buildup++;
                };

                let resolved_frames = await Promise.all(pool);
                resolved_frames.forEach((x, index) => {
                    let transformed_objs = x.objects_tmp.map(obj => {
                        obj.X = obj.X + x.offset_x;
						obj.LINKED_GROUP = (buildup - threads_to_use) + index + 1
                        return obj;
                    });
                    objects.push(transformed_objs);
                    transformed_objs.forEach(z => z.SCALING > min_scale ? $.add(z) : saved++)
                })
                console.log(`batch ${curr_iter + 1} done (frames left: ${iterations_left})`);
				console.timeEnd(`batch ${curr_iter + 1}`)

                curr_iter++;
            }
            save_cleanup();
        } else {
            // Worker thread logic
            const frameNumber = workerData;
            let frame_crt = await processFrameAsync(frameNumber);
            parentPort.postMessage(frame_crt);
        }

        return;
    }

    let file = await readfile(json_data.filepath);
    file = JSON.parse(file.toString());

    let fscale = file.scale;
    let rescale = 3.4;
    let do_rs = true;

    let optimize = true;

    file.objects.forEach((objs, ofsx) => {
        let ofsx2 = (ofsx * 750);
        objs.forEach((obj, ci) => {
            if (do_rs) {
                let [nx, ny, nscale] = [((obj.X + ofsx2) * fscale), obj.Y * fscale, obj.SCALING * 4 * fscale];

                obj.X = ((nx / rescale) - ofsx2) + 1500 * ofsx;
                obj.Y = ny / rescale;
                obj.SCALING = nscale / rescale / 4
            }
			obj.DONT_FADE = true;
			obj.DONT_ENTER = true;
            if (optimize) {
                if (obj.SCALING > min_scale)
                    $.add(obj)
                else {
                    saved++;
                }
            } else {
                $.add(obj);
            }
        });
    });
    console.timeEnd('finished in');
    if (saved) console.log('amount of objects saved:', saved)
    $.exportToSavefile({
        info: true
    });
})();
