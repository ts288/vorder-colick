from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str
    gemini_model: str = "gemini-2.5-flash"
    server_port: int = 8000

    class Config:
        env_file = ".env"


settings = Settings()
