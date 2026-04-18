from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    llm_provider: str = "openai"

    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    server_port: int = 8000

    class Config:
        env_file = ".env"


settings = Settings()
