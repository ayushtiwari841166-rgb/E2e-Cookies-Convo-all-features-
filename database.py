import sqlite3
import json

DB_FILE = 'automation.db'

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    user_id TEXT,
                    task_type TEXT,
                    status TEXT,
                    config TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )''')
    c.execute('''CREATE TABLE IF NOT EXISTS locked_groups (
                    group_uid TEXT PRIMARY KEY,
                    user_id TEXT,
                    target_name TEXT,
                    target_photo_path TEXT,
                    nicknames TEXT,
                    is_active INTEGER DEFAULT 0
                )''')
    conn.commit()
    conn.close()

def create_task(task_id, user_id, task_type, config):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("INSERT OR REPLACE INTO tasks (task_id, user_id, task_type, status, config) VALUES (?, ?, ?, ?, ?)",
              (task_id, user_id, task_type, 'running', json.dumps(config)))
    conn.commit()
    conn.close()

def update_task_status(task_id, status):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("UPDATE tasks SET status = ? WHERE task_id = ?", (status, task_id))
    conn.commit()
    conn.close()

def get_active_tasks(user_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT task_id, task_type, status, created_at FROM tasks WHERE user_id = ? AND status = 'running'", (user_id,))
    rows = c.fetchall()
    conn.close()
    return rows

def stop_task(task_id):
    update_task_status(task_id, 'stopped')

def is_task_running(task_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT status FROM tasks WHERE task_id = ?", (task_id,))
    result = c.fetchone()
    conn.close()
    return result and result[0] == 'running'

def save_locked_group(user_id, group_uid, target_name, target_photo_path, nicknames):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''INSERT OR REPLACE INTO locked_groups 
                 (group_uid, user_id, target_name, target_photo_path, nicknames, is_active) 
                 VALUES (?, ?, ?, ?, ?, 1)''',
              (group_uid, user_id, target_name, target_photo_path, json.dumps(nicknames)))
    conn.commit()
    conn.close()

def get_locked_groups(user_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT group_uid, target_name, is_active, target_photo_path, nicknames FROM locked_groups WHERE user_id = ?", (user_id,))
    rows = c.fetchall()
    conn.close()
    return rows

init_db()
