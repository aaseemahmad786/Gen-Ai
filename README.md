# Gen-Ai Workbench

A fast, modern chat interface supporting Google Gemini and Groq with real-time streaming.

## Features

- **Integrated Models**:
  - **Google Gemini**: `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`
  - **Groq**: `qwen/qwen3.8-27b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `allam-2-7b`
- **Real-Time Streaming**: Server-Sent Events (SSE) stream tokens as they arrive.
- **Rich Markdown & Code Highlighting**: Syntax-formatted code blocks with one-click copy, tables, bold, italics, quotes, and links.
- **Preset & Custom Models**: Choose tested model presets or specify custom model IDs.
- **System Instructions**: Quick persona presets (Code Expert, Explainer, Concise, etc.) plus custom instructions.
- **Chat Management**: Sidebar conversation history, delete individual chats, clear history, and export conversations to Markdown.
- **Stop & Retry**: Abort generation mid-stream or retry any assistant response with a single click.

## Run Locally

1. Install [uv](https://docs.astral.sh/uv/).
2. Copy `.env.example` to `.env` and add the provider keys you want to use.
3. Run:
   ```bash
   uv run python app.py
   ```
4. Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

> Optional: Set `APP_PASSWORD` in `.env` to enable Basic Auth.

## Deploy to Render

The `render.yaml` Blueprint creates a Python web service. It prompts for optional `APP_PASSWORD` and provider API keys in the Render dashboard. Health checks are served at `/healthz`.
