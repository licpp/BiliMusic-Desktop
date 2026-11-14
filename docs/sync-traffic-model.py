#!/usr/bin/env python3
"""Analytical library/progress traffic model, not a sync implementation benchmark.

Uses only synthetic constants. No network, credentials, or user databases.
Run: python3 docs/sync-traffic-model.py --devices 1 2 3 5
Sizes include estimated HTTP overhead, exclude TLS framing and statistics.
"""
import argparse
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Assumptions:
    days: int = 30
    foreground_hours_per_device: float = 2
    poll_minutes: float = 3
    legacy_document_bytes: int = 500_000
    library_batches_per_device_day: int = 30
    progress_batches_per_device_day: int = 120
    library_delta_bytes: int = 1024
    progress_delta_bytes: int = 256
    head_bytes: int = 1024
    manifest_bytes: int = 4096
    retained_commit_markers: int = 4
    checkpoint_bytes_per_device_day: int = 144 * 1024
    checkpoint_domains_per_day: int = 2
    overhead_bytes_each_direction_per_request: int = 1024


def estimate(devices: int, a: Assumptions) -> dict:
    """Conservative: every peer fetches every new object, no checkpoint skips.

    All devices assumed to consume all commits eventually. Actor-directory
    probes fetch no payloads. Each commit has object + manifest + marker.
    ETag and PROPFIND shortcuts for v2 deliberately not assumed.
    """
    days = a.days
    polls = days * a.foreground_hours_per_device * 60 / a.poll_minutes
    overhead = a.overhead_bytes_each_direction_per_request
    legacy_gets = devices * devices * polls
    # One main-directory PROPFIND per device per cycle. Linked extension omitted.
    legacy_gets += devices * polls
    legacy_down = devices * devices * polls * a.legacy_document_bytes
    legacy_down += legacy_gets * overhead
    legacy_idle_up = legacy_gets * overhead
    # Active envelope: all participating devices publish at each poll.
    legacy_puts = devices * polls
    legacy_active_up = legacy_idle_up + legacy_puts * (
        a.legacy_document_bytes + overhead
    )

    batches_day = (
        a.library_batches_per_device_day + a.progress_batches_per_device_day
    )
    commits_day = batches_day + a.checkpoint_domains_per_day
    objects_day = (
        a.library_batches_per_device_day * a.library_delta_bytes
        + a.progress_batches_per_device_day * a.progress_delta_bytes
        + a.checkpoint_bytes_per_device_day
    )
    # Each actor owns all its uploads; receipt of remote data produces no upload.
    puts = days * devices * commits_day * 3
    # Conservative steady-state GC: one superseded marker DELETE per commit.
    deletes = days * devices * commits_day
    actor_listings = devices * devices * polls
    actor_listing_body = 1024 + 256 * a.retained_commit_markers
    # One control-directory listing per local round, including actor discovery.
    listings = devices * polls
    listing_body = 1024 + 256 * devices
    # Every remote peer fetches each new commit + manifest + referenced object.
    change_gets = days * devices * (devices - 1) * commits_day * 3
    # Verify each owned commit before deleting older markers.
    own_verification_gets = days * devices * commits_day
    gets = actor_listings + change_gets + listings + own_verification_gets
    v2_up = days * devices * (
        objects_day + commits_day * (a.head_bytes + a.manifest_bytes)
    ) + (puts + gets + deletes) * overhead
    v2_down = actor_listings * actor_listing_body + listings * listing_body
    v2_down += own_verification_gets * a.head_bytes
    v2_down += days * devices * (devices - 1) * (
        objects_day + commits_day * (a.head_bytes + a.manifest_bytes)
    )
    v2_down += (gets + puts + deletes) * overhead
    return {
        "devices": devices,
        "legacy_idle_upload_MB": round(legacy_idle_up / 1e6, 2),
        "legacy_download_MB": round(legacy_down / 1e6, 2),
        "legacy_active_upload_envelope_MB": round(legacy_active_up / 1e6, 2),
        "v2_active_upload_MB": round(v2_up / 1e6, 2),
        "v2_active_download_MB": round(v2_down / 1e6, 2),
        "legacy_payload_upload_envelope_MB": round(
            devices * polls * a.legacy_document_bytes / 1e6, 2
        ),
        "v2_requests": round(puts + gets + deletes),
        "download_reduction_percent": round(100 * (1 - v2_down / legacy_down), 1),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--devices", type=int, nargs="+", default=[1, 2, 3, 5])
    parser.add_argument("--document-kb", type=float, default=500)
    parser.add_argument("--library-batches", type=int, default=30)
    parser.add_argument("--progress-batches", type=int, default=120)
    parser.add_argument("--manifest-kb", type=float, default=4.096)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if any(d < 1 or d > 10 for d in args.devices):
        parser.error("devices must be between 1 and 10")
    if args.document_kb <= 0 or args.manifest_kb <= 0:
        parser.error("document and manifest sizes must be positive")
    if args.library_batches < 0 or args.progress_batches < 0:
        parser.error("batch counts must be nonnegative")
    idle = args.library_batches + args.progress_batches == 0
    a = Assumptions(
        legacy_document_bytes=round(args.document_kb * 1000),
        library_batches_per_device_day=args.library_batches,
        progress_batches_per_device_day=args.progress_batches,
        manifest_bytes=round(args.manifest_kb * 1000),
        checkpoint_bytes_per_device_day=0 if idle else 144 * 1024,
        checkpoint_domains_per_day=0 if idle else 2,
    )
    rows = [estimate(d, a) for d in args.devices]
    if args.json:
        print(json.dumps({"assumptions": asdict(a), "results": rows}, indent=2))
        return
    print("Synthetic model; decimal MB; statistics, first restore, TLS and retries excluded.")
    print("Legacy linked-folder traffic, MKCOL and v1 migration monitoring excluded.")
    print("Legacy active upload is an envelope, not measured or predicted traffic.")
    print("V2 models external objects and immutable commit markers; no inline-tail savings.")
    print("All peers fetch all commits/checkpoints; no ETag or skipped-generation savings.")
    print("| devices | v1 download MB | v1 active upload envelope MB | v2 upload MB | v2 download MB | v2 requests | download reduction |")
    print("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in rows:
        print(
            "| {devices} | {legacy_download_MB} | {legacy_active_upload_envelope_MB} | "
            "{v2_active_upload_MB} | {v2_active_download_MB} | {v2_requests} | "
            "{download_reduction_percent}% |".format(**row)
        )


if __name__ == "__main__":
    main()
