const express = require('express');
const multer = require('multer');
const login = require('@dongdev/fca-unofficial');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// 🔐 SECURITY PASSWORD (Isko change kar lena)
const SECRET_PASSWORD = "Admin@123";

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
    if (req.body.auth_key !== SECRET_PASSWORD) {
        return res.json({ status: "error", message: "❌ Galat Password!" });
    }
    if (serverState.isRunning) {
        return res.json({ status: "error", message: "Server pehle se chal raha hai!" });
    }

    const { cookies, thread_id, time_delay, sender_name, proxy_url } = req.body;
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

    runSenderProcess(cookies, thread_id, parseInt(time_delay), sender_name, proxy_url, file.path);
});

async function runSenderProcess(cookiesRaw, threadId, delay, senderName, proxyUrl, filePath) {
    let api;
    let proxyAgent = null;

    try {
        if (proxyUrl) {
            addLog(`🌐 Setting Proxy: ${proxyUrl.substring(0, 15)}...`);
            proxyAgent = new HttpsProxyAgent(proxyUrl);
        } else {
            addLog("⚠️ Bina Proxy ke chal raha hai. (Render IP Blocked)");
        }

        let appState = [];
        try {
            appState = JSON.parse(cookiesRaw);
        } catch (e) {
            cookiesRaw.split(';').forEach(pair => {
                const [k, v] = pair.split('=');
                if (k && v) appState.push({ key: k.trim(), value: v.trim(), domain: "facebook.com", path: "/" });
            });
        }

        addLog("🔐 Logging into Facebook (fca-unofficial)...");
        
        // ✅ FCA Login
        api = await new Promise((resolve, reject) => {
            login({ appState: appState }, (err, api) => {
                if (err) return reject(err);
                resolve(api);
            });
        });

        addLog(`✅ Login Successful! UID: ${api.getCurrentUserID()}`);
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
                // ✅ FCA Send Message (Promise wrapper)
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
