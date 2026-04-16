from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from .config import settings
    from .models.schemas import ProcessState
    from .routers.plan import router as plan_router
except ImportError:
    from config import settings
    from models.schemas import ProcessState
    from routers.plan import router as plan_router


app = FastAPI(title="Vorder-Colick LLM Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.state.sessions: dict[str, ProcessState] = {}

app.include_router(plan_router)


@app.get("/health")
def health():
    return {"status": "ok", "sessions": len(app.state.sessions)}
