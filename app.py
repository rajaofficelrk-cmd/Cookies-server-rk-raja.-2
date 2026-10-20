import os
import json
import asyncio
import threading
import logging
import base64
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
from fbchat_muqit import Client, ThreadType

# ==========================================
# 🚀 APP CONFIGURATION
# ==========================================
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB max limit
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ==========================================
# 📝 LOGGING & STATE MANAGEMENT
# ==========================================
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Global State for Server
server_state = {
    "is_running": False,
    "status": "Idle",
    "logs": [],
    "total_sent": 0,
    "total_failed": 0
}
stop_event = threading.Event()
sending_thread = None

def add_log(message):
    timestamp = datetime.now().strftime("%H:%M:%S")
    log_msg = f"[{timestamp}] {message}"
    server_state["logs"].append(log_msg)
    if len(server_state["logs"]) > 100:  # Keep only last 100 logs to save memory
        server_state["logs"].pop(0)
    logger.info(message)

# ==========================================
# 🌐 ROUTES
# ==========================================
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status', methods=['GET'])
def get_status():
    return jsonify(server_state)

@app.route('/api/stop', methods=['POST'])
def stop_sending():
    global server_state
    if not server_state["is_running"]:
        return jsonify({"status": "error", "message": "Server pehle se band hai."})
    
    stop_event.set()
    server_state["status"] = "Stopping..."
    add_log("🛑 STOP signal received. Finishing current message...")
    return jsonify({"status": "success", "message": "Stop signal bhej diya gaya."})

@app.route('/api/start', methods=['POST'])
def start_sending():
    global sending_thread, server_state
    
    if server_state["is_running"]:
        return jsonify({"status": "error", "message": "Server pehle se chal raha hai!"})

    # 1. Data Receive Karein
    cookies_data = request.form.get('cookies', '').strip()
    thread_id = request.form.get('thread_id', '').strip()
    thread_type_str = request.form.get('thread_type', 'GROUP').upper()
    time_delay = request.form.get('time_delay', '10')
    sender_name = request.form.get('sender_name', 'Unknown').strip()
    message_file = request.files.get('message_file')

    # 2. Strict Validation
    if not cookies_data: return jsonify({"status": "error", "message": "Cookies required!"})
    if not thread_id: return jsonify({"status": "error", "message": "Group UID required!"})
    if not message_file: return jsonify({"status": "error", "message": "Message File required!"})
    
    try:
        time_delay = int(time_delay)
        if time_delay < 5: raise ValueError
    except ValueError:
        return jsonify({"status": "error", "message": "Delay kam se kam 5 seconds ka hona chahiye!"})

    # 3. File & Cookies Save Karein
    try:
        # Save Cookies
        cookies_path = os.path.join(app.config['UPLOAD_FOLDER'], 'cookies.json')
        parsed_cookies = json.loads(cookies_data)
        with open(cookies_path, 'w', encoding='utf-8') as f:
            json.dump(parsed_cookies, f)
        
        # Save Message File
        filename = secure_filename(message_file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        message_file.save(filepath)
    except Exception as e:
        return jsonify({"status": "error", "message": f"File save error: {str(e)}"})

    # 4. Reset State & Start Thread
    stop_event.clear()
    server_state["is_running"] = True
    server_state["status"] = "Starting Bot..."
    server_state["logs"] = []
    server_state["total_sent"] = 0
    server_state["total_failed"] = 0
    
    thread_type = ThreadType.GROUP if thread_type_str == 'GROUP' else ThreadType.USER

    sending_thread = threading.Thread(
        target=run_async_worker,
        args=(cookies_path, thread_id, thread_type, filepath, time_delay, sender_name)
    )
    sending_thread.daemon = True
    sending_thread.start()
    
    add_log(f"🚀 Server Started by {sender_name} for {thread_id}")
    return jsonify({"status": "success", "message": "Server chalu ho gaya!"})

# ==========================================
# ⚙️ BACKGROUND WORKER (The Core Logic)
# ==========================================
def run_async_worker(cookies_path, thread_id, thread_type, filepath, delay, sender_name):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(bulk_sender_logic(cookies_path, thread_id, thread_type, filepath, delay, sender_name))
    except Exception as e:
        add_log(f"❌ Critical Thread Error: {str(e)}")
    finally:
        loop.close()
        server_state["is_running"] = False
        server_state["status"] = "Idle"
        add_log("💤 Server thread stopped.")

async def bulk_sender_logic(cookies_path, thread_id, thread_type, filepath, delay, sender_name):
    bot = None
    try:
        add_log("🔐 Logging into Facebook...")
        bot = await Client.startSession(cookies_path)
        
        if not await bot.isLoggedIn():
            add_log("❌ Login Failed! Cookies expire ho gayi hain.")
            server_state["status"] = "Login Failed"
            return
        
        add_log(f"✅ Login Successful! UID: {bot.uid}")
        server_state["status"] = "Sending Messages..."

        # Read File Line by Line
        with open(filepath, 'r', encoding='utf-8') as f:
            messages = [line.strip() for line in f if line.strip()]

        total = len(messages)
        if total == 0:
            add_log("⚠️ File khali hai.")
            server_state["status"] = "File Empty"
            return

        add_log(f"📁 Total {total} messages to send. Delay: {delay}s")

        for idx, msg in enumerate(messages, 1):
            if stop_event.is_set():
                add_log("🛑 Loop stopped by user.")
                break

            # Format Message with Here Name
            final_message = f"{msg}\n\n— {sender_name}"

            try:
                await bot.sendMessage(final_message, thread_id, thread_type)
                server_state["total_sent"] += 1
                add_log(f"✅ [{idx}/{total}] Sent: {msg[:30]}...")
            except Exception as e:
                server_state["total_failed"] += 1
                add_log(f"❌ [{idx}/{total}] Failed: {str(e)}")
            
            # Smart Delay (Stop check karte hue)
            for _ in range(delay):
                if stop_event.is_set():
                    break
                await asyncio.sleep(1)

    except Exception as e:
        add_log(f"❌ System Error: {str(e)}")
    finally:
        if bot:
            try: await bot.stop()
            except: pass
        server_state["is_running"] = False
        if not stop_event.is_set():
            server_state["status"] = "Completed"
            add_log("🎉 All messages processed successfully!")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, threaded=True)
