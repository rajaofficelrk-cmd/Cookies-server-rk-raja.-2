import os
import asyncio
import json
import threading
import logging
from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
from fbchat_muqit import Client, ThreadType

# --- Configuration ---
UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'txt'}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB max

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Global State ---
sending_thread = None
stop_event = threading.Event()
is_running = False
current_status = "Idle"

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/start', methods=['POST'])
def start_sending():
    global sending_thread, is_running, current_status
    
    if is_running:
        return jsonify({"status": "error", "message": "Server pehle se chal raha hai!"})

    # --- Form Data Receive ---
    cookie_data = request.form.get('cookies', '').strip()
    thread_id = request.form.get('thread_id', '').strip()
    thread_type_str = request.form.get('thread_type', 'GROUP').upper()
    time_delay = request.form.get('time_delay', '10')
    sender_name = request.form.get('sender_name', 'Unknown').strip()
    
    # --- Validation ---
    if not cookie_data:
        return jsonify({"status": "error", "message": "Cookies khali hain!"})
    if not thread_id:
        return jsonify({"status": "error", "message": "Thread ID khali hai!"})
    
    try:
        time_delay = int(time_delay)
        if time_delay < 5:
            return jsonify({"status": "error", "message": "Time delay kam se kam 5 seconds hona chahiye."})
    except ValueError:
        return jsonify({"status": "error", "message": "Time delay ek number hona chahiye."})
    
    # --- File Upload Validation ---
    if 'message_file' not in request.files:
        return jsonify({"status": "error", "message": "Message file missing!"})
    
    file = request.files['message_file']
    if file.filename == '':
        return jsonify({"status": "error", "message": "File select nahi ki gayi!"})
    
    if not allowed_file(file.filename):
        return jsonify({"status": "error", "message": "Sirf .txt file allowed hai."})
    
    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    
    # --- Cookies Save ---
    try:
        cookies_dict = json.loads(cookie_data)
        cookies_path = os.path.join(app.config['UPLOAD_FOLDER'], 'cookies.json')
        with open(cookies_path, 'w', encoding='utf-8') as f:
            json.dump(cookies_dict, f)
    except json.JSONDecodeError:
        return jsonify({"status": "error", "message": "Cookies valid JSON format mein nahi hain."})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Cookies save karne mein error: {str(e)}"})
    
    # --- ThreadType Determine ---
    thread_type = ThreadType.GROUP if thread_type_str == 'GROUP' else ThreadType.USER
    
    # --- Background Thread Start ---
    stop_event.clear()
    is_running = True
    current_status = "Starting..."
    
    sending_thread = threading.Thread(
        target=run_async_sender,
        args=(cookies_path, thread_id, thread_type, filepath, time_delay, sender_name)
    )
    sending_thread.daemon = True
    sending_thread.start()
    
    logger.info(f"Started sender for {thread_id} ({thread_type_str}) by {sender_name}")
    return jsonify({"status": "success", "message": f"Server chalu! Messages bhejna shuru ({thread_type_str})."})

@app.route('/stop', methods=['POST'])
def stop_sending():
    global is_running, current_status
    if not is_running:
        return jsonify({"status": "error", "message": "Server chal nahi raha."})
    
    stop_event.set()
    current_status = "Stopping..."
    logger.info("Stop signal bheja gaya.")
    return jsonify({"status": "success", "message": "Stop signal bhej diya gaya. Server ruk raha hai..."})

@app.route('/status', methods=['GET'])
def get_status():
    global is_running, current_status
    return jsonify({"is_running": is_running, "status": current_status})

def run_async_sender(cookies_path, thread_id, thread_type, file_path, delay, sender_name):
    global is_running, current_status
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(send_bulk(cookies_path, thread_id, thread_type, file_path, delay, sender_name))
    finally:
        loop.close()
        is_running = False
        current_status = "Idle"
        logger.info("Sender thread band ho gaya.")

async def send_bulk(cookies_path, thread_id, thread_type, file_path, delay, sender_name):
    global is_running, current_status
    bot = None
    try:
        current_status = "Logging in..."
        bot = await Client.startSession(cookies_path)
        
        if not await bot.isLoggedIn():
            logger.error("Login failed. Cookies invalid or expired.")
            current_status = "Login failed"
            return
        
        current_status = "Logged in. Sending messages..."
        
        with open(file_path, 'r', encoding='utf-8') as f:
            messages = [line.strip() for line in f if line.strip()]
        
        if not messages:
            current_status = "File khali hai"
            return
        
        total = len(messages)
        
        for idx, msg in enumerate(messages, 1):
            if stop_event.is_set():
                break
            
            # --- YAHAN SENDER NAME ADD HO RAHA HAI ---
            final_message = f"{msg}\n\n— {sender_name}"
            
            try:
                await bot.sendMessage(final_message, thread_id, thread_type)
                logger.info(f"[{idx}/{total}] Sent by {sender_name}: {msg[:30]}...")
                current_status = f"Sent {idx}/{total}"
            except Exception as e:
                logger.error(f"Error sending message {idx}: {e}")
                current_status = f"Error at {idx}"
            
            # Delay check
            for _ in range(delay):
                if stop_event.is_set():
                    break
                await asyncio.sleep(1)
        
        current_status = "Completed" if not stop_event.is_set() else "Stopped by user"
        
    except Exception as e:
        logger.error(f"System error: {e}")
        current_status = f"Error: {str(e)}"
    finally:
        if bot:
            try:
                await bot.stop()
            except Exception:
                pass
        stop_event.clear()
        is_running = False

if __name__ == '__main__':
    # Render deployment ke liye PORT setting
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
