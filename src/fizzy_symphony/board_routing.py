"""Board-native discovery and routing decisions for Fizzy Symphony."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Set, Union

from fizzy_symphony.board_contracts import (
    CompletionPolicy,
    GoldenTicketRoute,
    NormalizedCard,
    NormalizedComment,
    build_routes_by_column,
    normalize_card,
    normalize_comment,
)


CommentProvider = Callable[[NormalizedCard], Sequence[Union[Mapping[str, Any], NormalizedComment]]]
CommentsByCard = Mapping[Union[int, str], Sequence[Union[Mapping[str, Any], NormalizedComment]]]

TERMINAL_STATES = {"archived", "closed", "complete", "completed", "done"}
POSTPONED_MARKERS = {"not-now", "not_now", "postpone", "postponed"}

__all__ = [
    "RoutingDecision",
    "discover_routes_by_column",
    "route_board_cards",
]


@dataclass(frozen=True)
class RoutingDecision:
    """A side-effect-free routing decision for one board card or route refresh."""

    action: str
    card: Optional[NormalizedCard] = None
    route: Optional[GoldenTicketRoute] = None
    reason: str = ""
    backend: str = ""
    completion_policy: Optional[CompletionPolicy] = None
    comments: Sequence[NormalizedComment] = field(default_factory=tuple)
    dedupe_key: str = ""


def discover_routes_by_column(
    *,
    board_id: str,
    cards: Sequence[Mapping[str, Any]],
    columns: Sequence[Mapping[str, Any]],
    comments_provider: Optional[CommentProvider] = None,
    comments_by_card: Optional[CommentsByCard] = None,
) -> Dict[str, GoldenTicketRoute]:
    """Return ``column_id -> route`` using board-native golden ticket contracts."""

    return build_routes_by_column(
        [_card_with_column_aliases(card) for card in cards],
        board_id=board_id,
        columns=columns,
    )


def route_board_cards(
    *,
    board_id: str,
    cards: Sequence[Mapping[str, Any]],
    columns: Sequence[Mapping[str, Any]],
    active_card_numbers: Sequence[Union[int, str]] = (),
    leased_card_numbers: Sequence[Union[int, str]] = (),
    changed_card_numbers: Sequence[Union[int, str]] = (),
    comments_provider: Optional[CommentProvider] = None,
    comments_by_card: Optional[CommentsByCard] = None,
    include_ignored: bool = False,
) -> Sequence[RoutingDecision]:
    """Build deterministic spawn/ignore/refresh/cancel decisions for board cards."""

    active_numbers = _normalize_card_numbers(active_card_numbers)
    leased_numbers = _normalize_card_numbers(leased_card_numbers)
    changed_numbers = _normalize_card_numbers(changed_card_numbers)
    discovery_cards = [_card_for_route_discovery(card, changed_numbers) for card in cards]
    routes_by_column = discover_routes_by_column(
        board_id=board_id,
        cards=discovery_cards,
        columns=columns,
        comments_provider=comments_provider,
        comments_by_card=comments_by_card,
    )

    normalized_cards = sorted((_normalize_card_for_routing(card) for card in cards), key=_sort_key)
    decisions = []
    decisions.extend(_refresh_decisions(board_id, normalized_cards, routes_by_column, changed_numbers))

    for card in normalized_cards:
        reason = _ineligible_reason(card, routes_by_column)
        if card.number in active_numbers and reason:
            decisions.append(
                RoutingDecision(
                    action="cancel",
                    card=card,
                    reason=reason,
                    dedupe_key=f"{board_id}:{card.number}:cancel",
                )
            )
            continue
        if reason:
            if include_ignored:
                decisions.append(RoutingDecision(action="ignore", card=card, reason=reason))
            continue
        if card.number in active_numbers:
            if include_ignored:
                decisions.append(RoutingDecision(action="ignore", card=card, reason="already_running"))
            continue
        if card.number in leased_numbers:
            if include_ignored:
                decisions.append(RoutingDecision(action="ignore", card=card, reason="already_leased"))
            continue

        route = routes_by_column[card.column_id]
        decisions.append(
            RoutingDecision(
                action="spawn",
                card=card,
                route=route,
                backend=route.backend,
                completion_policy=route.completion_policy,
                comments=_comments_for_card(
                    card,
                    comments_provider=comments_provider,
                    comments_by_card=comments_by_card,
                ),
                dedupe_key=f"{board_id}:{card.number}:{route.column_id}:{route.card_number}",
            )
        )

    return tuple(decisions)


def _refresh_decisions(
    board_id: str,
    cards: Sequence[NormalizedCard],
    routes_by_column: Mapping[str, GoldenTicketRoute],
    changed_numbers: Set[int],
) -> Sequence[RoutingDecision]:
    if not changed_numbers:
        return ()

    route_by_number = {route.card_number: route for route in routes_by_column.values()}
    decisions = []
    for card in cards:
        if card.number not in changed_numbers:
            continue
        route = route_by_number.get(card.number)
        if route is None and not _has_golden_signal(card):
            continue
        decisions.append(
            RoutingDecision(
                action="refresh_golden_tickets",
                card=card,
                route=route,
                reason="golden_ticket_changed",
                dedupe_key=f"{board_id}:{card.number}:refresh_golden_tickets",
            )
        )
    return tuple(decisions)


def _ineligible_reason(
    card: NormalizedCard,
    routes_by_column: Mapping[str, GoldenTicketRoute],
) -> str:
    if card.golden:
        return "golden_ticket"
    if _is_closed(card):
        return "closed"
    if _is_postponed(card):
        return "postponed"
    if not card.column_id:
        return "no_column"
    if card.column_id not in routes_by_column:
        return "unconfigured_column"
    return ""


def _is_closed(card: NormalizedCard) -> bool:
    raw = card.raw
    if raw.get("closed") is True or raw.get("archived") is True:
        return True
    return _normalized_raw_word(raw, "state", "status") in TERMINAL_STATES


def _is_postponed(card: NormalizedCard) -> bool:
    raw = card.raw
    if raw.get("postponed") is True:
        return True
    if any(tag in POSTPONED_MARKERS for tag in card.tags):
        return True
    if _normalized_raw_word(raw, "state", "status") in POSTPONED_MARKERS:
        return True
    return _normalized_word(card.column_id) in POSTPONED_MARKERS or _normalized_word(card.column_name) in POSTPONED_MARKERS


def _comments_for_card(
    card: NormalizedCard,
    *,
    comments_provider: Optional[CommentProvider],
    comments_by_card: Optional[CommentsByCard],
) -> Sequence[NormalizedComment]:
    raw_comments: Sequence[Union[Mapping[str, Any], NormalizedComment]] = ()
    if comments_provider is not None:
        raw_comments = comments_provider(card)
    elif comments_by_card is not None:
        raw_comments = (
            comments_by_card.get(card.number)
            or comments_by_card.get(str(card.number))
            or comments_by_card.get(card.id)
            or ()
        )
    return tuple(_normalize_comment(comment) for comment in raw_comments)


def _normalize_comment(comment: Union[Mapping[str, Any], NormalizedComment]) -> NormalizedComment:
    if isinstance(comment, NormalizedComment):
        return comment
    return normalize_comment(comment)


def _normalize_card_for_routing(card: Mapping[str, Any]) -> NormalizedCard:
    return normalize_card(_card_with_column_aliases(card))


def _card_for_route_discovery(
    card: Mapping[str, Any],
    changed_numbers: Set[int],
) -> Mapping[str, Any]:
    normalized_card = _normalize_card_for_routing(card)
    if (
        normalized_card.number in changed_numbers
        and normalized_card.golden
        and "agent-instructions" in normalized_card.tags
        and not normalized_card.column_id
    ):
        discovery_card = dict(card)
        discovery_card["golden"] = False
        return discovery_card
    return card


def _card_with_column_aliases(card: Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(card.get("column"), Mapping):
        return card

    column_id = card.get("column_id")
    column_name = card.get("column_name")
    if column_id in (None, "") and column_name in (None, ""):
        return card

    normalized = dict(card)
    normalized["column"] = {"id": column_id or "", "name": column_name or ""}
    return normalized


def _normalize_card_numbers(card_numbers: Sequence[Union[int, str]]) -> Set[int]:
    normalized = set()
    for card_number in card_numbers:
        try:
            normalized.add(int(card_number))
        except (TypeError, ValueError):
            continue
    return normalized


def _has_golden_signal(card: NormalizedCard) -> bool:
    return card.golden or "agent-instructions" in card.tags


def _sort_key(card: NormalizedCard) -> tuple[int, str]:
    return (card.number, card.id)


def _normalized_raw_word(raw: Mapping[str, Any], *names: str) -> str:
    for name in names:
        value = raw.get(name)
        if value not in (None, ""):
            return _normalized_word(value)
    return ""


def _normalized_word(value: object) -> str:
    return str(value or "").strip().lower().replace(" ", "-")
