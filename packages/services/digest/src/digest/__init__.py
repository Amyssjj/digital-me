# Digital Me — Daily Digest
# Gathers each day's cross-agent activity, has an LLM agent summarize it, and
# publishes a Discord digest. The summarize->publish seam is governed by an
# explicit versioned contract (presentation.schema.json) and the publisher
# fails OPEN to a deterministic render, so a producer drift degrades the digest
# instead of silently dropping it.

__version__ = "0.1.0"
