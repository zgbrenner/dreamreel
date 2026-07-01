"""Effect registry. Swapping effects is just picking a different registered name."""

from __future__ import annotations

from .base import Effect, EffectContext

_REGISTRY: dict[str, Effect] = {}


def register(name: str):
    def decorator(fn: Effect) -> Effect:
        if name in _REGISTRY:
            raise ValueError(f"Effect '{name}' is already registered")
        _REGISTRY[name] = fn
        return fn

    return decorator


def get(name: str) -> Effect:
    try:
        return _REGISTRY[name]
    except KeyError as exc:
        raise ValueError(
            f"Unknown effect '{name}'. Available: {available()}"
        ) from exc


def available() -> list[str]:
    return sorted(_REGISTRY)


# Imported for registration side effects -- each module below calls @register(...).
from . import dream_gate, ghost_trail, glitch_resolve, tint  # noqa: E402,F401

__all__ = ["Effect", "EffectContext", "register", "get", "available"]
