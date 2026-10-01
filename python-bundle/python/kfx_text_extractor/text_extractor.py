"""Extract text from a PidIndex for a given pid range."""


def extract_text(index, start_pid: int, end_pid: int) -> str:
    """Extract text for the given pid range from a PidIndex.

    Args:
        index: PidIndex containing the pid-to-text mapping
        start_pid: Start position (inclusive)
        end_pid: End position (inclusive)

    Returns:
        Extracted text for the pid range
    """
    if start_pid > end_pid:
        return ""

    if not index.pid_map:
        return ""

    # Get sorted pid keys for sequential lookup
    sorted_keys = sorted(index.pid_map.keys())

    result_parts = []
    target_start = start_pid
    target_end = end_pid

    for key in sorted_keys:
        chunk_end, chunk_text = index.pid_map[key]

        # Skip chunks before our range
        if chunk_end < target_start:
            continue

        # Skip chunks after our range
        if key > target_end:
            break

        # Calculate overlap
        overlap_start = max(target_start, key)
        overlap_end = min(target_end, chunk_end)

        if overlap_start <= overlap_end:
            # Extract the overlapping portion
            char_start = overlap_start - key
            char_end = overlap_end - key + 1
            result_parts.append(chunk_text[char_start:char_end])

    return "".join(result_parts)
