"""Local GenAI chat app with a small, dependency-free web interface."""

from __future__ import annotations

import base64
import hmac
import json
import os
import threading
import urllib.error
import urllib.request
from collections.abc import Generator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"

PROVIDERS: dict[str, dict[str, Any]] = {
    "google": {
        "name": "Gemini",
        "env": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "default_model": "gemini-3.1-flash-lite",
        "models": [
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash-lite",
        ],
    },
    "groq": {
        "name": "Groq",
        "env": ("GROQ_API_KEY",),
        "default_model": "qwen/qwen3.8-27b",
        "models": [
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "allam-2-7b",
        ],
        "endpoint": "https://api.groq.com/openai/v1/chat/completions",
    },
}


def load_dotenv(override: bool = False) -> None:
    """Load simple KEY=value entries from .env."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value.startswith(("'", '"')) and value.endswith(("'", '"')):
            value = value[1:-1]
        if key and (override or key not in os.environ):
            os.environ[key] = value


load_dotenv()

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
APP_USER = os.environ.get("APP_USER", "genai")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


def get_api_key(provider: str) -> str | None:
    load_dotenv(override=True)
    env_vars = PROVIDERS.get(provider, {}).get("env", ())
    if not env_vars:
        return "not-required"  # local providers like Ollama
    for name in env_vars:
        key = os.environ.get(name, "").strip()
        if key and not key.lower().startswith(("your_", "replace_me", "add_")):
            return key
    return None


def extract_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        raw_body = exc.read().decode("utf-8", "replace")
        details = json.loads(raw_body)
        if isinstance(details, dict):
            err = details.get("error")
            if isinstance(err, dict):
                msg = err.get("message")
                if msg:
                    return str(msg)
            elif isinstance(err, str):
                return err
            if details.get("message"):
                return str(details["message"])
    except Exception:
        pass
    if exc.code in {401, 403}:
        return f"Authentication failed (HTTP {exc.code}). Verify your API key in .env."
    if exc.code == 404:
        return f"Model or endpoint not found (HTTP 404). Check the model identifier."
    if exc.code == 429:
        return f"Rate limit or quota exceeded (HTTP 429). Check your provider credits/limits."
    return f"Provider returned HTTP {exc.code}."


def stream_openai_compatible(
    endpoint: str,
    payload: dict[str, Any],
    headers: dict[str, str],
) -> Generator[str, None, None]:
    payload["stream"] = True
    body = json.dumps(payload).encode("utf-8")
    req_headers = {
        "Content-Type": "application/json",
        "User-Agent": "GenAIWorkbench/1.1 (Windows; Python)",
        **headers,
    }
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers=req_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk_obj = json.loads(data_str)
                    choices = chunk_obj.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                except json.JSONDecodeError:
                    continue
    except urllib.error.HTTPError as exc:
        raise RuntimeError(extract_http_error(exc)) from None
    except TimeoutError:
        raise RuntimeError("Provider timed out after 120s.") from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise RuntimeError(f"Could not reach provider: {reason}") from None


def stream_reply(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    system_prompt: str,
    temperature: float,
) -> Generator[str, None, None]:
    if provider not in PROVIDERS:
        raise ValueError("Choose a supported provider.")
    api_key = get_api_key(provider)
    if not api_key:
        raise ValueError(f"Add an API key for {PROVIDERS[provider]['name']} to .env, then restart the app.")
    if not model.strip():
        raise ValueError("Enter a model name.")

    safe_messages = []
    for item in messages[-40:]:
        role, content = item.get("role"), item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            safe_messages.append({"role": role, "content": content[:20000]})
    if not safe_messages or safe_messages[-1]["role"] != "user":
        raise ValueError("Send a user message to start a response.")

    model_clean = model.strip()

    if provider == "google":
        langchain_messages = []
        if system_prompt.strip():
            langchain_messages.append(SystemMessage(content=system_prompt[:4000]))
        langchain_messages.extend(
            HumanMessage(content=item["content"]) if item["role"] == "user"
            else AIMessage(content=item["content"])
            for item in safe_messages
        )
        try:
            chat_model = ChatGoogleGenerativeAI(
                model=model_clean,
                google_api_key=api_key,
                max_tokens=None,
                timeout=120,
                max_retries=2,
                temperature=temperature,
            )
            for chunk in chat_model.stream(langchain_messages):
                text = chunk.content
                if isinstance(text, list):
                    text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
                elif not isinstance(text, str):
                    text = str(text) if text is not None else ""
                if text:
                    yield text
        except Exception as exc:
            raise RuntimeError(f"Gemini request failed: {exc}") from None
        return

    # Providers using OpenAI-compatible HTTP chat completions (Groq)
    endpoint = PROVIDERS[provider]["endpoint"]
    headers: dict[str, str] = {}
    if api_key and api_key != "not-required":
        headers["Authorization"] = f"Bearer {api_key}"

    chat_messages = []
    if system_prompt.strip():
        chat_messages.append({"role": "system", "content": system_prompt[:4000]})
    chat_messages.extend(safe_messages)

    payload = {
        "model": model_clean,
        "messages": chat_messages,
        "temperature": temperature,
    }
    yield from stream_openai_compatible(endpoint, payload, headers)


def generate_reply(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    system_prompt: str,
    temperature: float,
) -> str:
    chunks: list[str] = []
    for chunk in stream_reply(provider, model, messages, system_prompt, temperature):
        chunks.append(chunk)
    result = "".join(chunks).strip()
    if not result:
        raise RuntimeError("Provider returned an empty response. Try another model or prompt.")
    return result


class AppHandler(BaseHTTPRequestHandler):
    server_version = "GenAIWorkbench/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def authorize(self) -> bool:
        if not APP_PASSWORD:
            return True
        authorization = self.headers.get("Authorization", "")
        try:
            scheme, encoded = authorization.split(" ", 1)
            supplied = base64.b64decode(encoded, validate=True).decode("utf-8") if scheme.lower() == "basic" else ""
        except (ValueError, UnicodeDecodeError):
            supplied = ""
        if hmac.compare_digest(supplied, f"{APP_USER}:{APP_PASSWORD}"):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="GenAI Workbench"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if not self.authorize():
            return
        if self.path == "/api/config":
            configured = {provider: bool(get_api_key(provider)) for provider in PROVIDERS}
            # Prefer google or first configured provider
            first_ready = "google" if configured.get("google") else next(
                (p for p, ready in configured.items() if ready), "groq"
            )
            self.send_json(
                200,
                {
                    "providers": {
                        provider: {
                            "name": config["name"],
                            "default_model": config["default_model"],
                            "models": config.get("models", [config["default_model"]]),
                            "configured": configured[provider],
                            "is_local": len(config.get("env", ())) == 0,
                        }
                        for provider, config in PROVIDERS.items()
                    },
                    "default_provider": first_ready,
                },
            )
            return

        relative = "index.html" if self.path in {"/", "/index.html"} else self.path.lstrip("/")
        candidate = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in candidate.parents and candidate != WEB_ROOT.resolve():
            self.send_error(403)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        content_type = (
            "text/html; charset=utf-8" if candidate.suffix == ".html"
            else "text/css; charset=utf-8" if candidate.suffix == ".css"
            else "text/javascript; charset=utf-8" if candidate.suffix == ".js"
            else "application/octet-stream"
        )
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self.authorize():
            return
        if self.path not in {"/api/chat", "/api/chat/stream"}:
            self.send_json(404, {"error": "Unknown endpoint."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                raise ValueError("Request size must be between 1 byte and 1 MB.")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            provider = str(body.get("provider", ""))
            model = str(body.get("model", ""))
            messages = body.get("messages", [])
            system_prompt = str(body.get("system_prompt", ""))
            temperature = float(body.get("temperature", 0.7))
            if not isinstance(messages, list) or not 0 <= temperature <= 2:
                raise ValueError("Messages must be a list and temperature must be between 0 and 2.")

            if self.path == "/api/chat/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                try:
                    for chunk in stream_reply(provider, model, messages, system_prompt, temperature):
                        payload = json.dumps({"chunk": chunk})
                        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    self.wfile.write(b"data: {\"done\": true}\n\n")
                    self.wfile.flush()
                except Exception as exc:
                    err_payload = json.dumps({"error": str(exc)})
                    try:
                        self.wfile.write(f"data: {err_payload}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                        pass
                return

            reply = generate_reply(provider, model, messages, system_prompt, temperature)
            self.send_json(200, {"reply": reply})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except RuntimeError as exc:
            self.send_json(502, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": f"Server error: {exc}"})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"GenAI Workbench is ready at http://{HOST}:{PORT}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping GenAI Workbench...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
