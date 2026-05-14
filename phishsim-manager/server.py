"""
PhishSim Manager — runs on the R720 at port 7777.
Provisions / deprovisions GoPhish Docker containers on demand.

Each container gets:
  - An internal admin port (3400–3499) for the GoPhish REST API
  - An internal phishing port (8100–8199) exposed via Traefik subdomain

Auth: Bearer token via PHISHSIM_SECRET env var.
State: persisted in /home/guy/phishsim-manager/state.json
"""

import json, os, re, subprocess, sqlite3, tempfile, time, secrets, hashlib
from flask import Flask, request, jsonify

app = Flask(__name__)

SECRET       = os.environ.get("PHISHSIM_SECRET", "change-me-in-systemd")
STATE_FILE   = os.path.join(os.path.dirname(__file__), "state.json")
ADMIN_PORT_BASE = 3400
PHISH_PORT_BASE = 8100
MAX_INSTANCES   = 80
GOPHISH_IMAGE   = "gophish/gophish:latest"
PHISH_HOST      = os.environ.get("PHISH_HOST", "phishsim.edgeiqlabs.com")

SES_SMTP_HOST = os.environ.get("SES_SMTP_HOST", "email-smtp.us-east-2.amazonaws.com")
SES_SMTP_USER = os.environ.get("SES_SMTP_USER", "")
SES_SMTP_PASS = os.environ.get("SES_SMTP_PASS", "")

# ── State helpers ─────────────────────────────────────────────────────────────

def load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    with open(STATE_FILE) as f:
        return json.load(f)

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def next_free_slot(state):
    used = {v["slot"] for v in state.values()}
    for i in range(MAX_INSTANCES):
        if i not in used:
            return i
    return None

# ── Auth ──────────────────────────────────────────────────────────────────────

def check_auth():
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {SECRET}":
        return jsonify({"error": "Unauthorized"}), 401
    return None

# ── Docker helpers ────────────────────────────────────────────────────────────

def docker(args, check=True, combined=False):
    if combined:
        result = subprocess.run(["docker"] + args, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    else:
        result = subprocess.run(["docker"] + args, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result.stdout.strip()

def wait_for_gophish(container_name, timeout=40):
    for _ in range(timeout):
        logs = docker(["logs", container_name], check=False, combined=True)
        if "Starting admin server" in logs:
            return True
        time.sleep(1)
    return False

def extract_api_key(container_name):
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        docker(["cp", f"{container_name}:/opt/gophish/gophish.db", tmp_path])
        conn = sqlite3.connect(tmp_path)
        row = conn.execute("SELECT api_key FROM users WHERE username='admin'").fetchone()
        conn.close()
        return row[0] if row else None
    finally:
        os.unlink(tmp_path)

def generate_password():
    return secrets.token_urlsafe(16)

def create_default_smtp_profile(admin_port, api_key):
    if not SES_SMTP_USER or not SES_SMTP_PASS:
        return False
    import urllib.request, json as _json, ssl
    payload = _json.dumps({
        "name": "EdgeIQ SES",
        "host": f"{SES_SMTP_HOST}:587",
        "from_address": "noreply@phishsim.edgeiqlabs.com",
        "username": SES_SMTP_USER,
        "password": SES_SMTP_PASS,
        "ignore_cert_errors": True,
    }).encode()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        f"https://localhost:{admin_port}/api/smtp/",
        data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": api_key}
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
            return r.status in (200, 201)
    except Exception:
        return False

def change_gophish_password(admin_port, api_key, new_password):
    import urllib.request, json as _json, ssl
    payload = _json.dumps({"username": "admin", "password": new_password, "role": "admin"}).encode()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        f"https://localhost:{admin_port}/api/users/1",
        data=payload,
        method="PUT",
        headers={"Content-Type": "application/json", "Authorization": api_key}
    )
    with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
        return r.status == 200

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.route("/provision", methods=["POST"])
def provision():
    err = check_auth()
    if err:
        return err

    data       = request.get_json(silent=True) or {}
    customer_id = data.get("customer_id", "")
    if not customer_id:
        return jsonify({"error": "customer_id required"}), 400

    state = load_state()
    if customer_id in state:
        inst = state[customer_id]
        return jsonify({"status": "exists", **inst}), 200

    slot = next_free_slot(state)
    if slot is None:
        return jsonify({"error": "No capacity available"}), 503

    admin_port = ADMIN_PORT_BASE + slot
    phish_port = PHISH_PORT_BASE + slot
    container  = f"gophish-{customer_id[:12]}"
    subdomain  = f"c{slot}.{PHISH_HOST}"

    try:
        docker([
            "run", "-d",
            "--name", container,
            "--restart", "unless-stopped",
            "-p", f"127.0.0.1:{admin_port}:3333",
            "-p", f"{phish_port}:80",
            "--label", "traefik.enable=true",
            "--label", f"traefik.http.routers.gophish-{slot}.rule=Host(`{subdomain}`)",
            "--label", f"traefik.http.routers.gophish-{slot}.entrypoints=web,websecure",
            "--label", f"traefik.http.routers.gophish-{slot}.tls.certresolver=letsencrypt",
            "--label", f"traefik.http.services.gophish-{slot}.loadbalancer.server.port=80",
            GOPHISH_IMAGE
        ])
    except RuntimeError as e:
        return jsonify({"error": f"Failed to start container: {e}"}), 500

    if not wait_for_gophish(container):
        docker(["stop", container], check=False)
        docker(["rm", container], check=False)
        return jsonify({"error": "GoPhish did not start in time"}), 500

    api_key = extract_api_key(container)
    if not api_key:
        docker(["stop", container], check=False)
        docker(["rm", container], check=False)
        return jsonify({"error": "Could not extract API key"}), 500

    new_password = generate_password()
    try:
        change_gophish_password(admin_port, api_key, new_password)
    except Exception:
        pass  # non-fatal — key still works

    create_default_smtp_profile(admin_port, api_key)

    record = {
        "customer_id":  customer_id,
        "slot":         slot,
        "container":    container,
        "admin_port":   admin_port,
        "phish_port":   phish_port,
        "phish_url":    f"https://{subdomain}",
        "api_key":      api_key,
        "admin_password": new_password,
        "created_at":   int(time.time()),
    }
    state[customer_id] = record
    save_state(state)

    return jsonify({"status": "provisioned", **record}), 201


@app.route("/deprovision/<customer_id>", methods=["DELETE"])
def deprovision(customer_id):
    err = check_auth()
    if err:
        return err

    state = load_state()
    inst  = state.get(customer_id)
    if not inst:
        return jsonify({"error": "Not found"}), 404

    docker(["stop", inst["container"]], check=False)
    docker(["rm",   inst["container"]], check=False)
    del state[customer_id]
    save_state(state)
    return jsonify({"status": "deprovisioned"}), 200


@app.route("/instance/<customer_id>", methods=["GET"])
def get_instance(customer_id):
    err = check_auth()
    if err:
        return err

    state = load_state()
    inst  = state.get(customer_id)
    if not inst:
        return jsonify({"error": "Not found"}), 404

    # Check live container status
    status = docker(["inspect", "--format", "{{.State.Status}}", inst["container"]], check=False)
    return jsonify({**inst, "container_status": status}), 200


@app.route("/containers", methods=["GET"])
def list_containers():
    err = check_auth()
    if err:
        return err

    state = load_state()
    return jsonify({"count": len(state), "instances": list(state.values())}), 200


@app.route("/proxy/<customer_id>/<path:gophish_path>", methods=["GET","POST","PUT","DELETE"])
def proxy(customer_id, gophish_path):
    err = check_auth()
    if err:
        return err

    state = load_state()
    inst  = state.get(customer_id)
    if not inst:
        return jsonify({"error": "Not found"}), 404

    import urllib.request, ssl as _ssl
    ctx = _ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE

    url = f"https://localhost:{inst['admin_port']}/api/{gophish_path}"
    body = request.get_data() or None
    req = urllib.request.Request(
        url,
        data=body if body else None,
        method=request.method,
        headers={
            "Content-Type":  request.content_type or "application/json",
            "Authorization": inst["api_key"],
        }
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
            data = r.read()
            return app.response_class(data, status=r.status,
                                      mimetype="application/json")
    except urllib.error.HTTPError as e:
        return app.response_class(e.read(), status=e.code,
                                  mimetype="application/json")
    except Exception as ex:
        return jsonify({"error": str(ex)}), 502


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True}), 200


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7777, debug=False)
