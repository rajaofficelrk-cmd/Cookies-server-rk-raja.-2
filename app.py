import os
import re
import json
import asyncio
import threading
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
from fbchat_muqit import Client, ThreadType

# ==========================================
# 🚀 APP CONFIGURATION
# ==========================================
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

server_state = {"is_running": False, "status": "Idle", "logs": [], "total_sent": 0, "total_failed": 0}
stop_event = threading.Event()
sending_thread = None

def add_log(message):
    timestamp = datetime.now().strftime("%H:%M:%S")
    log_msg = f"[{timestamp}] {message}"
    server_state["logs"].append(log_msg)
    if len(server_state["logs"]) > 150: server_state["logs"].pop(0)
    logger.info(message)

def parse_cookies(cookie_input):
    cookie_input = cookie_input.strip()
    if cookie_input.startswith('[') and cookie_input.endswith(']'):
        try:
            parsed = json.loads(cookie_input)
            if isinstance(parsed, list): return parsed
        except: pass
    if ';' in cookie_input or '=' in cookie_input:
        cookies = []
        for pair in cookie_input.split(';'):
            if '=' in pair:
                k, v = pair.split('=', 1)
                cookies.append({"key": k.strip(), "value": v.strip()})
        if cookies: return cookies
    raise ValueError("Invalid cookie format.")

@app.route('/')
def index(): return render_template('index.html')

@app.route('/ping')
def ping(): return "OK", 200

@app.route('/api/status', methods=['GET'])
def get_status(): return jsonify(server_state)

@app.route('/api/stop', methods=['POST'])
def stop_sending():
    if not server_state["is_running"]: return jsonify({"status": "error", "message": "Server pehle se band hai."})
    stop_event.set()
    server_state["status"] = "Stopping..."
    add_log("🛑 STOP signal received.")
    return jsonify({"status": "success", "message": "Stop signal bhej diya gaya."})

@app.route('/api/start', methods=['POST'])
def start_sending():
    global sending_thread
    if server_state["is_running"]: return jsonify({"status": "error", "message": "Server pehle se chal raha hai!"})

    cookies_data = request.form.get('cookies', '').strip()
    raw_thread_id = request.form.get('thread_id', '').strip()
    time_delay = request.form.get('time_delay', '10')
    sender_name = request.form.get('sender_name', 'Unknown').strip()
    proxy_url = request.form.get('proxy_url', '').strip() # Naya Proxy Input
    message_file = request.files.get('message_file')

    if not cookies_data or not raw_thread_id or not message_file:
        return jsonify({"status": "error", "message": "Saari fields bharna zaroori hai!"})

    thread_id = ''.join(filter(str.isdigit, raw_thread_id))
    
    try:
        time_delay = int(time_delay)
        if time_delay < 5: raise ValueError
    except ValueError:
        return jsonify({"status": "error", "message": "Delay kam se kam 5 seconds ka hona chahiye!"})

    try:
        cookies_list = parse_cookies(cookies_data)
        cookies_path = os.path.join(app.config['UPLOAD_FOLDER'], 'cookies.json')
        with open(cookies_path, 'w', encoding='utf-8') as f: json.dump(cookies_list, f)
        
        filename = secure_filename(message_file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        message_file.save(filepath)
    except Exception as e:
        return jsonify({"status": "error", "message": f"File save error: {str(e)}"})

    stop_event.clear()
    server_state["is_running"] = True
    server_state["status"] = "Starting Bot..."
    server_state["logs"] = []
    server_state["total_sent"] = 0
    server_state["total_failed"] = 0

    sending_thread = threading.Thread(
        target=run_async_worker,
        args=(cookies_path, thread_id, filepath, time_delay, sender_name, proxy_url)
    )
    sending_thread.daemon = True
    sending_thread.start()
    
    add_log(f"🚀 Server Started by {sender_name} for Group ID: {thread_id}")
    return jsonify({"status": "success", "message": "Server chalu ho gaya!"})

def run_async_worker(cookies_path, thread_id, filepath, delay, sender_name, proxy_url):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(bulk_sender_logic(cookies_path, thread_id, filepath, delay, sender_name, proxy_url))
    except Exception as e:
        add_log(f"❌ Critical Thread Error: {str(e)}")
    finally:
        loop.close()
        server_state["is_running"] = False
        server_state["status"] = "Idle"
        add_log("💤 Server thread stopped.")

async def bulk_sender_logic(cookies_path, thread_id, filepath, delay, sender_name, proxy_url):
    bot = None
    try:
        # ✅ PROXY SETUP (Agar proxy daali hai toh Render ka IP change ho jayega)
        if proxy_url:
            add_log(f"🌐 Setting Proxy: {proxy_url[:15]}...")
            os.environ['HTTP_PROXY'] = proxy_url
            os.environ['HTTPS_PROXY'] = proxy_url
        else:
            add_log("⚠️ Bina Proxy ke chal raha hai. Render IP block ho sakta hai.")

        add_log("🔐 Logging into Facebook...")
        bot = Client(cookies_file_path=cookies_path)
        await bot.start()
        add_log(f"✅ Login Successful! UID: {bot.uid}")

        server_state["status"] = "Sending Messages..."
        
        messages = []
        try:
            with open(filepath, 'r', encoding='utf-8-sig') as f: messages = [line.strip() for line in f if line.strip()]
        except UnicodeDecodeError:
            with open(filepath, 'r', encoding='latin-1') as f: messages = [line.strip() for line in f if line.strip()]

        total = len(messages)
        if total == 0:
            add_log("⚠️ File khali hai.")
            return

        add_log(f"📁 Total {total} messages. Delay: {delay}s")

        for idx, msg in enumerate(messages, 1):
            if stop_event.is_set():
                add_log("🛑 Loop stopped by user.")
                break

            final_message = f"{msg}\n— {sender_name}"
            success = False
            
            try:
                # 10 Second timeout
                await asyncio.wait_for(bot.sendMessage(final_message, thread_id, ThreadType.GROUP), timeout=10.0)
                success = True
            except asyncio.TimeoutError:
                add_log(f"⏭️ [{idx}/{total}] Timeout. Skip...")
            except Exception as e:
                add_log(f"❌ [{idx}/{total}] Error: {str(e)}")
            
            if success:
                server_state["total_sent"] += 1
                add_log(f"✅ [{idx}/{total}] Sent: {msg[:30]}...")
            else:
                server_state["total_failed"] += 1
            
            if not stop_event.is_set() and idx < total:
                for _ in range(delay):
                    if stop_event.is_set(): break
                    await asyncio.sleep(1)

    except Exception as e:
        add_log(f"❌ System Error: {str(e)}")
    finally:
        if bot:
            try:
                if hasattr(bot, 'stop'): await bot.stop()
            except: pass
        
        if not stop_event.is_set() and server_state["total_sent"] > 0:
            server_state["status"] = "Completed"
            add_log("🎉 Process complete!")
        elif server_state["total_sent"] == 0 and not stop_event.is_set():
            server_state["status"] = "Failed"

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, threaded=True)
