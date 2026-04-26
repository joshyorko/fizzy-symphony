"""Future Fizzy OpenAPI adapter scaffold.

The official SDK repository is https://github.com/basecamp/fizzy-sdk.
That repository currently ships Go, TypeScript, Ruby, Swift, and Kotlin SDKs,
but not a Python SDK. ``openapi.json`` is the source of truth for a future
Python implementation, and the generated TypeScript cards service is the
reference for supported card operations and semantics.

This module deliberately avoids real HTTP behavior in the current scaffold.
"""

from __future__ import annotations


class FizzyOpenAPIAdapter:
    """Future real API-backed tracker adapter.

    This adapter should be implemented from basecamp/fizzy-sdk/openapi.json.
    It exists now to make the adapter strategy explicit without adding HTTP
    behavior yet, and it should eventually implement the ``TrackerAdapter``
    protocol.
    """

    sdk_repository = "https://github.com/basecamp/fizzy-sdk"
    openapi_source = "openapi.json"
    cards_service_reference = "typescript/src/generated/services/cards.ts"

