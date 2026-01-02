import streamlit as st
import time
import threading
import json
import os
import uuid
import database as db
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from gtts import gTTS

# --- Background Styling ---
st.markdown(
    f"""
    <style>
    .stApp {{
        background-image: url("https://i.ibb.co/7t2b2TpC/1751604019030.jpg");
        background-attachment: fixed;
        background-size: cover;
    }}
    .stMarkdown, .stSubheader, .stTitle, .stInfo, .stHeader, .stTabs, .stExpander, div[data-testid="stVerticalBlock"] > div {{
        background-color: rgba(255, 255, 255, 0.85);
        padding: 15px;
        border-radius: 12px;
        color: #1a1a1a !important;
        border: 1px solid rgba(0,0,0,0.1);
    }}
    </style>
    """,
    unsafe_allow_html=True
)

# --- Dynamic Context Handler ---
def get_add_script_run_context():
    locations = ["streamlit.runtime.scriptrunner", "streamlit.runtime.scriptrunner.script_run_context", "streamlit.scriptrunner"]
    for loc in locations:
        try:
            module = __import__(loc, fromlist=["add_script_run_context"])
            return getattr(module, "add_script_run_context")
        except: continue
    return lambda t: t

add_script_run_context_fn = get_add_script_run_context()

LOG_FILE = "background_logs.txt"
LOG_LOCK = threading.Lock()

def log_message(message, task_id=None):
    ts = time.strftime('%H:%M:%S')
    prefix = f"Task {task_id[:8]}: " if task_id else ""
    log_entry = f"[{ts}] {prefix}{message}"
    with LOG_LOCK:
        try:
            with open(LOG_FILE, "a") as f: f.write(log_entry + "\n")
        except: pass
    print(log_entry)

def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument('--headless=new')
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    chrome_options.add_argument('--window-size=1920,1080')
    chrome_options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    chrome_options.add_argument('--disable-blink-features=AutomationControlled')
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    
    paths = ['/usr/bin/chromedriver', '/usr/local/bin/chromedriver']
    service = None
    for p in paths:
        if os.path.exists(p):
            from selenium.webdriver.chrome.service import Service
            service = Service(executable_path=p); break
    if service: return webdriver.Chrome(service=service, options=chrome_options)
    return webdriver.Chrome(options=chrome_options)

def add_cookies(driver, cookies_str, task_id=None):
    try:
        log_message("Attempting to add cookies...", task_id)
        driver.get("https://www.facebook.com")
        time.sleep(2)
        if cookies_str.strip().startswith('['):
            for c in json.loads(cookies_str):
                driver.add_cookie({'name': c.get('name'), 'value': c.get('value'), 'domain': '.facebook.com', 'path': '/'})
        else:
            for cookie in cookies_str.split(';'):
                if '=' in cookie:
                    parts = cookie.split('=', 1)
                    if len(parts) == 2:
                        driver.add_cookie({'name': parts[0].strip(), 'value': parts[1].strip(), 'domain': '.facebook.com', 'path': '/'})
        log_message("Cookies added. Refreshing...", task_id)
        driver.refresh()
        time.sleep(4)
        if "login" not in driver.current_url.lower():
            log_message("Login SUCCESSFUL via cookies.", task_id)
            return True
        log_message("Login FAILED via cookies.", task_id)
        return False
    except Exception as e:
        log_message(f"Cookie Error: {str(e)}", task_id)
        return False

def task_message_sender(task_id, config):
    driver = None
    try:
        log_message("SENDER TASK INITIALIZED", task_id)
        db.update_task_status(task_id, 'running')
        driver = setup_driver()
        if not add_cookies(driver, config['cookies'], task_id): 
            db.update_task_status(task_id, 'failed')
            return

        targets = config.get('targets', [])
        messages = config.get('messages', [])
        image_paths = config.get('image_paths', [])
        audio_paths = config.get('audio_paths', [])
        delay = int(config.get('delay', 10))
        mode = config.get('mode')
        
        msg_idx, img_idx, aud_idx = 0, 0, 0
        
        while db.is_task_running(task_id):
            for target in targets:
                if not db.is_task_running(task_id): break
                log_message(f"Navigating to target: {target}", task_id)
                driver.get(f"https://www.facebook.com/messages/t/{target}")
                time.sleep(6)
                try:
                    msg_text = messages[msg_idx % len(messages)] if messages else ""
                    if config.get('prefix') and msg_text: msg_text = f"{config['prefix']} {msg_text}"
                    
                    # Find message input
                    input_box = None
                    for s in ['div[role="textbox"]', 'div[aria-label="Message"]', 'div[contenteditable="true"]']:
                        try:
                            input_box = WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.CSS_SELECTOR, s)))
                            if input_box: break
                        except: continue
                    
                    if input_box:
                        # Find file input
                        file_input = None
                        try:
                            file_input = driver.find_element(By.CSS_SELECTOR, 'input[type="file"][accept*="image"], input[type="file"][accept*="audio"], input[type="file"]')
                        except: pass

                        if mode == 'Voice (TTS)' and msg_text:
                            log_message(f"Generating TTS for: {msg_text[:20]}...", task_id)
                            tts = gTTS(text=msg_text, lang='hi'); path = os.path.abspath(f"temp_{task_id}.mp3"); tts.save(path)
                            if file_input: 
                                file_input.send_keys(path)
                                log_message("TTS file uploaded.", task_id)
                                time.sleep(5)
                        elif mode == 'Audio File' and audio_paths:
                            aud_path = audio_paths[aud_idx % len(audio_paths)]
                            log_message(f"Uploading Audio: {os.path.basename(aud_path)}", task_id)
                            if file_input: 
                                file_input.send_keys(aud_path)
                                aud_idx += 1
                                log_message("Audio file uploaded.", task_id)
                                time.sleep(6)
                        elif mode == 'Text + Image' and image_paths:
                            img_path = image_paths[img_idx % len(image_paths)]
                            log_message(f"Uploading Image: {os.path.basename(img_path)}", task_id)
                            if file_input: 
                                file_input.send_keys(img_path)
                                img_idx += 1
                                log_message("Image file uploaded.", task_id)
                                time.sleep(5)
                        
                        if msg_text:
                            input_box.send_keys(msg_text)
                            time.sleep(1)
                            input_box.send_keys(Keys.ENTER)
                        else:
                            # If no text, try sending just media via Enter on input box or specialized send button
                            input_box.send_keys(Keys.ENTER)
                            
                        log_message(f"SUCCESS: Message sent to {target}", task_id)
                    else:
                        log_message(f"ERROR: Input field not found for {target}", task_id)
                except Exception as e:
                    log_message(f"SEND ERROR for {target}: {str(e)}", task_id)
                
                time.sleep(delay)
            msg_idx += 1
            if not config.get('loop', True): break
    except Exception as e:
        log_message(f"CRITICAL ERROR: {str(e)}", task_id)
    finally:
        if driver: driver.quit()
        db.update_task_status(task_id, 'completed')
        log_message("SENDER TASK COMPLETED", task_id)

st.set_page_config(page_title="FB Multi-Sender", layout="wide")
if 'user_id' not in st.session_state: st.session_state.user_id = str(uuid.uuid4())

st.title("🚀 FB Multi-Sender Pro")
menu = st.sidebar.radio("Navigation", ["Dashboard", "Message Sender", "Task Manager"])

def show_status_section():
    st.divider()
    col1, col2 = st.columns([1, 1])
    with col1:
        st.subheader("📊 Active Sessions")
        tasks = db.get_active_tasks(st.session_state.user_id)
        if tasks:
            for t in tasks:
                tid, ttype, status, created = t
                with st.expander(f"{ttype.upper()} | {tid[:8]} | {status}"):
                    if st.button("Terminate Session", key=f"stop_{tid}"):
                        db.stop_task(tid)
                        st.rerun()
        else: st.info("No active sessions currently running.")
    with col2:
        st.subheader("📜 Live Activity Log")
        logs = []
        try:
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE, "r") as f: logs = f.readlines()[-150:]
        except: pass
        st.text_area("Live Logs", value="".join(reversed(logs)), height=350, label_visibility="collapsed")
        if st.button("Clear Logs"):
            if os.path.exists(LOG_FILE): os.remove(LOG_FILE)
            st.rerun()
        if st.button("Refresh Log View"): st.rerun()

if menu == "Dashboard":
    st.info(f"System Operational | Welcome, User {st.session_state.user_id[:8]}")
    show_status_section()

elif menu == "Message Sender":
    st.header("📤 Message Sender Configuration")
    col_a, col_b = st.columns(2)
    with col_a:
        cookies = st.text_area("Account Cookies (JSON or String)", height=150)
        target_ids = st.text_area("Target User/Group IDs (One per line)", height=150)
    with col_b:
        mode = st.selectbox("Delivery Mode", ["Text Only", "Text + Image", "Voice (TTS)", "Audio File"])
        prefix = st.text_input("Message Prefix (Optional)")
        delay = st.number_input("Delay Between Messages (Seconds)", min_value=1, value=10)
        loop = st.checkbox("Loop Messages Permanently", value=True)

    st.subheader("📁 Media Attachments")
    msg_file = st.file_uploader("Upload Message Content (TXT file)", type=['txt'])
    img_files = st.file_uploader("Upload Images (Loop support)", accept_multiple_files=True, type=['png', 'jpg', 'jpeg'])
    aud_files = st.file_uploader("Upload Audio Files (Loop support)", accept_multiple_files=True, type=['mp3', 'wav'])
    
    if st.button("🚀 LAUNCH AUTOMATION", use_container_width=True):
        if not cookies or not target_ids:
            st.error("Cookies and Target IDs are required!")
        else:
            task_id = str(uuid.uuid4())
            msgs = msg_file.read().decode().splitlines() if msg_file else ["Hello from Automation!"]
            config = {
                'cookies': cookies, 'targets': target_ids.splitlines(), 'mode': mode, 
                'prefix': prefix, 'delay': delay, 'messages': msgs, 'loop': loop,
                'user_id': st.session_state.user_id, 'image_paths': [], 'audio_paths': []
            }
            # Save media locally for background access
            for i, img in enumerate(img_files or []):
                p = os.path.abspath(f"media_img_{task_id}_{i}{Path(img.name).suffix}")
                with open(p, "wb") as f: f.write(img.getbuffer())
                config['image_paths'].append(p)
            for i, aud in enumerate(aud_files or []):
                p = os.path.abspath(f"media_aud_{task_id}_{i}{Path(aud.name).suffix}")
                with open(p, "wb") as f: f.write(aud.getbuffer())
                config['audio_paths'].append(p)
            
            db.create_task(task_id, st.session_state.user_id, 'sender', config)
            t = threading.Thread(target=task_message_sender, args=(task_id, config))
            add_script_run_context_fn(t)
            t.start()
            st.success(f"Automation session {task_id[:8]} started successfully!")
            time.sleep(1)
            st.rerun()
    show_status_section()

elif menu == "Task Manager":
    st.header("⚙️ Session Management")
    show_status_section()
