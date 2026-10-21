const express = require('express');
const multer = require('multer');
const login = require('@dongdev/fca-unofficial');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

let serverState = {
    isRunning: false,
    status: "Idle",
    logs: [],
    totalSent: 0,
    totalFailed: 0,
    stopRequested: false
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    serverState.logs.push(logMsg);
    if (serverState.logs.length > 150) serverState.logs.shift();
    console.log(logMsg);
}

app.get('/api/status', (req, res) => {
    res.json(serverState);
});

app.post('/api/stop', (req, res) => {
    if (!serverState.isRunning) return res.json({ status: "error", message: "Server pehle se band hai." });
    serverState.stopRequested = true;
    serverState.status = "Stopping...";
    addLog("🛑 STOP signal received.");
    res.json({ status: "success", message: "Stop signal bhej diya gaya." });
});

app.post('/api/start', upload.single('message_file'), async (req, res) => {
    if (serverState.isRunning) {
        return res.json({ status: "error", message: "Server pehle se chal raha hai!" });
    }

    const { cookies, thread_id, time_delay, sender_name } = req.body;
    const file = req.file;

    if (!cookies || !thread_id || !file) {
        return res.json({ status: "error", message: "Saari fields bharna zaroori hai!" });
    }

    serverState = {
        isRunning: true,
        status: "Starting...",
        logs: [],
        totalSent: 0,
        totalFailed: 0,
        stopRequested: false
    };

    res.json({ status: "success", message: "Server chalu ho gaya!" });

    runSenderProcess(cookies, thread_id, parseInt(time_delay), sender_name, file.path);
});

async function runSenderProcess(cookiesRaw, threadId, delay, senderName, filePath) {
    let api;
    let mqttInstance = null;

    try {
        let appState = [];
        try {
            const parsed = JSON.parse(cookiesRaw);
            appState = parsed.map(c => ({ key: c.key, value: c.value, domain: "facebook.com", path: "/" }));
        } catch (e) {
            cookiesRaw.split(';').forEach(pair => {
                const [k, v] = pair.split('=');
                if (k && v) appState.push({ key: k.trim(), value: v.trim(), domain: "facebook.com", path: "/" });
            });
        }

        addLog("🔐 Logging into Facebook...");
        
        api = await new Promise((resolve, reject) => {
            login({ appState: appState }, (err, api) => {
                if (err) return reject(err);
                resolve(api);
            });
        });

        addLog(`✅ Login Successful! UID: ${api.getCurrentUserID()}`);

        // ✅ MQTT INITIALIZATION WITH READY EVENT
        addLog("📡 Initializing MQTT listener...");
        api.setOptions({ listenEvents: true, emitReady: true }); // emitReady true karein
        
        // EventEmitter style use karein
        mqttInstance = api.listenMqtt();
        
        // 'ready' event ka wait karein (max 10 second)
        await new Promise((resolve, reject) => {
            let isReady = false;
            const timeout = setTimeout(() => {
                if (!isReady) reject(new Error("MQTT connection timeout (10s)"));
            }, 10000);

            mqttInstance.on("ready", () => {
                isReady = true;
                clearTimeout(timeout);
                addLog("✅ MQTT Client Ready!");
                resolve();
            });

            mqttInstance.on("error", (err) => {
                if (!isReady) {
                    clearTimeout(timeout);
                    reject(err);
                } else {
                    addLog(`⚠️ MQTT Error: ${err.message}`);
                }
            });
        });

        serverState.status = "Sending Messages...";

        const messages = fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        if (messages.length === 0) throw new Error("File khali hai.");

        addLog(`📁 Total ${messages.length} messages. Delay: ${delay}s`);

        for (let i = 0; i < messages.length; i++) {
            if (serverState.stopRequested) {
                addLog("🛑 Loop stopped by user.");
                break;
            }

            const finalMessage = `${messages[i]}\n— ${senderName}`;

            try {
                await new Promise((resolve, reject) => {
                    api.sendMessage(finalMessage, threadId, (err) => {
                        if (err) return reject(err);
                        resolve();
                    });
                });

                serverState.totalSent++;
                addLog(`✅ [${i + 1}/${messages.length}] Sent: ${messages[i].substring(0, 30)}...`);
            } catch (err) {
                serverState.totalFailed++;
                addLog(`❌ [${i + 1}/${messages.length}] Error: ${err.message}`);
            }

            if (!serverState.stopRequested && i < messages.length - 1) {
                await new Promise(r => setTimeout(r, delay * 1000));
            }
        }

    } catch (error) {
        addLog(`❌ System Error: ${error.message}`);
        serverState.status = "Failed";
    } finally {
        // MQTT cleanup
        if (mqttInstance && typeof mqttInstance.stopListeningAsync === 'function') {
            try {
                await mqttInstance.stopListeningAsync();
                addLog("📡 MQTT Listener stopped.");
            } catch (e) {
                addLog(`⚠️ Error stopping MQTT: ${e.message}`);
            }
        }

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        serverState.isRunning = false;
        if (serverState.stopRequested) {
            serverState.status = "Stopped by User";
        } else if (serverState.totalSent > 0) {
            serverState.status = "Completed";
            addLog("🎉 Process complete!");
        } else {
            serverState.status = "Failed";
        }
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
