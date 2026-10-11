import re


def extract_team_tag(ign: str) -> str | None:
    """Infer a team tag from a leading bracketed or separated IGN prefix."""
    value = ign.strip()
    if not value:
        return None

    bracketed = re.match(r"^\[([^\]]+)\]", value)
    if bracketed:
        return bracketed.group(1).strip().upper() or None

    separated = re.match(r"^([^\s_\-|.:/\\\[\](){}]+)", value)
    if not separated:
        return None

    token = separated.group(1)
    if len(token) == len(value) and len(token) > 3:
        token = token[:3]
    return token.upper() or None
