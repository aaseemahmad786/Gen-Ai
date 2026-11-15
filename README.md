# Gen-Ai

A local chat interface for OpenAI, Groq, Gemini, and Hugging Face models.

## Run locally

1. Install [uv](https://docs.astral.sh/uv/).
2. Copy `.env.example` to `.env` and add the provider keys you want to use.
3. Run `uv sync --locked`.
4. Run `uv run python app.py` and open `http://127.0.0.1:8000`.

Set `APP_PASSWORD` to enable Basic Auth locally.

## Deploy to Render

The `render.yaml` Blueprint creates a free Python web service in Singapore. It prompts for `APP_PASSWORD` and provider API keys in the Render dashboard; secret values are not stored in this repository. The hosted app uses Basic Auth, with username `genai` by default. Its health check is available at `/healthz`.
