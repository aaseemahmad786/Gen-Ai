"""Local GenAI chat app with a small, dependency-free web interface."""

from __future__ import annotations

import base64
import hmac
import json
import os
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint
from langchain_openai import ChatOpenAI


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"

PROVIDERS: dict[str, dict[str, Any]] = {
    "openai": {
        "name": "OpenAI",
        "env": ("OPENAI_API_KEY",),
        "model": "gpt-5-nano",
    },
    "groq": {
        "name": "Groq",
        "env": ("GROQ_API_KEY",),
        "model": "openai/gpt-oss-20b",
        "endpoint": "https://api.groq.com/openai/v1/chat/completions",
    },
    "google": {
        "name": "Gemini",
        "env": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "model": "gemini-4-hydrogen",
    },
    "huggingface": {
        "name": "Hugging Face",
        "env": ("HUGGINGFACEHUB_ACCESS_TOKEN", "HF_TOKEN"),
        "model": "openai/gpt-oss-120b",
        "endpoint": "https://router.huggingface.co/v1/chat/completions",
    },
}


def load_dotenv() -> None:
    """Load simple KEY=value entries without overwriting the process environment."""
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
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
APP_USER = os.environ.get("APP_USER", "genai")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


def get_api_key(provider: str) -> str | None:
    for name in PROVIDERS[provider]["env"]:
        key = os.environ.get(name, "").strip()
        if key and not key.lower().startswith(("your_", "replace_me", "add_")):
            return key
    return None


def request_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw_body = exc.read().decode("utf-8", "replace")
        try:
            details = json.loads(raw_body)
            message = details.get("error", {}).get("message") or details.get("message")
        except (ValueError, AttributeError):
            message = None
        if not message and exc.code in {401, 403}:
            message = f"Provider rejected this API key or it lacks permission for this API/model (HTTP {exc.code}). Check the key and model access in your provider account."
        message = message or f"Provider returned HTTP {exc.code}."
        raise RuntimeError(message) from None
    except TimeoutError:
        raise RuntimeError("The model provider did not respond within 120 seconds. Try again or choose another model/provider.") from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise RuntimeError(f"Could not reach the model provider: {reason}") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError("The provider returned an unreadable response.") from None


def generate_reply(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    system_prompt: str,
    temperature: float,
) -> str:
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
                model=model.strip(),
                google_api_key=api_key,
                max_tokens=None,
                timeout=120,
                max_retries=2,
                temperature=temperature,
            )
            result = chat_model.invoke(langchain_messages)
        except Exception as exc:
            raise RuntimeError(f"Gemini request failed: {exc}") from None
        content = result.content
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Gemini returned no text. Try another model or prompt.")
        return content.strip()

    if provider == "openai":
        langchain_messages = []
        if system_prompt.strip():
            langchain_messages.append(SystemMessage(content=system_prompt[:4000]))
        langchain_messages.extend(
            HumanMessage(content=item["content"]) if item["role"] == "user"
            else AIMessage(content=item["content"])
            for item in safe_messages
        )
        try:
            chat_model = ChatOpenAI(
                model=model.strip(),
                api_key=api_key,
                max_tokens=None,
                timeout=120,
                max_retries=2,
                temperature=None if model.strip().lower().startswith("gpt-5") else temperature,
            )
            result = chat_model.invoke(langchain_messages)
        except Exception as exc:
            raise RuntimeError(f"OpenAI request failed: {exc}") from None
        content = result.content
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("OpenAI returned no text. Try another model or prompt.")
        return content.strip()

    if provider == "huggingface":
        langchain_messages = []
        if system_prompt.strip():
            langchain_messages.append(SystemMessage(content=system_prompt[:4000]))
        langchain_messages.extend(
            HumanMessage(content=item["content"]) if item["role"] == "user"
            else AIMessage(content=item["content"])
            for item in safe_messages
        )
        try:
            endpoint = HuggingFaceEndpoint(
                repo_id=model.strip(),
                task="text-generation",
                huggingfacehub_api_token=api_key,
                max_new_tokens=1024,
                temperature=temperature,
                do_sample=temperature > 0,
                timeout=120,
            )
            chat_model = ChatHuggingFace(llm=endpoint)
            result = chat_model.invoke(langchain_messages)
        except Exception as exc:
            raise RuntimeError(f"Hugging Face request failed: {exc}") from None
        content = result.content
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Hugging Face returned no text. Try another model or prompt.")
        return content.strip()

    chat_messages = []
    if system_prompt.strip():
        chat_messages.append({"role": "system", "content": system_prompt[:4000]})
    chat_messages.extend(safe_messages)
    payload = {"model": model.strip(), "messages": chat_messages, "temperature": temperature}
    endpoint = PROVIDERS[provider]["endpoint"]
    result = request_json(endpoint, payload, {"Authorization": f"Bearer {api_key}"})
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("The provider returned no text. Check the model name and try again.") from None
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("The provider returned an empty response.")
    return content.strip()


class AppHandler(BaseHTTPRequestHandler):
    server_version = "GenAIWorkbench/1.0"

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
            # A browser may close a long-running request before the provider replies.
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
            first_ready = "google" if configured["google"] else next(
                (provider for provider, ready in configured.items() if ready), None
            )
            self.send_json(
                200,
                {
                    "providers": {
                        provider: {"name": config["name"], "model": config["model"], "configured": configured[provider]}
                        for provider, config in PROVIDERS.items()
                    },
                    "default_provider": first_ready or "openai",
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
        content_type = "text/html; charset=utf-8" if candidate.suffix == ".html" else "text/css; charset=utf-8" if candidate.suffix == ".css" else "text/javascript; charset=utf-8"
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
        if self.path != "/api/chat":
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
            reply = generate_reply(provider, model, messages, system_prompt, temperature)
            self.send_json(200, {"reply": reply})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except RuntimeError as exc:
            self.send_json(502, {"error": str(exc)})
        except Exception:
            self.send_json(500, {"error": "Something went wrong while generating a response."})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"GenAI Workbench is ready at http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping GenAI Workbench...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
