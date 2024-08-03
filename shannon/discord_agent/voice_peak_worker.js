const { parentPort } = require('worker_threads');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

parentPort.on('message', (args) => {
    const { message, narrator, happy, sad, angry, fun, pitch, speed } = args;
    const exepath = "C:/Program Files/VOICEPEAK/voicepeak.exe";
    const outpath = path.join(__dirname, 'temp_voicepeak_output.wav');
    const execArgs = [
        exepath,
        "-s", message,
        "-n", narrator,
        "-o", outpath,
        "-e", `happy=${happy},sad=${sad},angry=${angry},fun=${fun}`,
        "--speed", speed.toString(),
        "--pitch", pitch.toString()
    ];

    const process = execFile(exepath, execArgs, (error) => {
        if (error) {
            parentPort.postMessage({ error });
            return;
        }

        fs.readFile(outpath, (err, data) => {
            if (err) {
                parentPort.postMessage({ error: err });
                return;
            }

            // 一時ファイルを削除
            fs.unlink(outpath, (unlinkErr) => {
                if (unlinkErr) {
                    console.error('Error deleting temp file:', unlinkErr);
                }
            });

            parentPort.postMessage({ buffer: data });
        });
    });

    // プロセスの優先度を上げる
    process.on('spawn', () => {
        const pid = process.pid;
        const { exec } = require('child_process');
        exec(`wmic process where processid="${pid}" CALL setpriority "high priority"`, (err, stdout, stderr) => {
            if (err) {
                console.error('Error setting process priority:', err);
            } else {
                console.log('Process priority set to high');
            }
        });
    });
});