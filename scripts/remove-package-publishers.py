from pathlib import Path
import re

path = Path(".github/workflows/ci.yml")
source = path.read_text()


def replace_exact(old: str, new: str, label: str) -> None:
    global source
    if old not in source:
        raise SystemExit(f"Expected {label} block was not found")
    source = source.replace(old, new, 1)


def strip_comment_before_job(name: str, first_line: str) -> None:
    global source
    job_marker = f"\n   {name}:\n"
    job_start = source.find(job_marker)
    if job_start < 0:
        raise SystemExit(f"Job {name} was not found")
    comment_start = source.rfind(first_line, 0, job_start)
    if comment_start < 0:
        raise SystemExit(f"Comment for {name} was not found")
    source = source[:comment_start].rstrip() + "\n\n" + source[job_start:].lstrip("\n")


def remove_job(name: str) -> None:
    global source
    job_marker = f"\n   {name}:\n"
    job_start = source.find(job_marker)
    if job_start < 0:
        raise SystemExit(f"Job {name} was not found")
    search_from = job_start + len(job_marker)
    next_job = re.search(r"\n   [A-Za-z0-9_]+:\n", source[search_from:])
    end = search_from + next_job.start() if next_job else len(source)
    source = source[:job_start].rstrip() + "\n\n" + source[end:].lstrip("\n")


replace_exact(
    '''   workflow_dispatch:
      inputs:
         skip_npm:
            description: "Skip npm publish"
            type: boolean
            default: false
''',
    '''   workflow_dispatch:
''',
    "workflow_dispatch npm input",
)

replace_exact(
    '''   # A pushed `v*` ref is authoritative for release builds and publishing.
   # Main still runs normal validation for the version-bump commit, while the
   # tag run builds the platform binaries in parallel and publishes only after
   # its own validation gate succeeds. A manual dispatch from a tagged main HEAD
''',
    '''   # A pushed `v*` ref is authoritative for release builds and GitHub releases.
   # Main still runs normal validation for the version-bump commit, while the
   # tag run builds the platform binaries in parallel and creates the GitHub
   # release only after its own validation gate succeeds. A manual dispatch from a tagged main HEAD
''',
    "release overview comment",
)

replace_exact(
    '''   # Aggregates every validation job so publish-side release jobs gate on one
   # result. Binary BUILDS deliberately do not wait for this gate — they run
   # in parallel with the test fan-out and only publishing is held back.
''',
    '''   # Aggregates every validation job so GitHub release publication gates on one
   # result. Binary builds deliberately do not wait for this gate — they run
   # in parallel with the test fan-out while release publication is held back.
''',
    "release gate comment",
)

replace_exact(
    '''   # Builds (does not publish) the Linux-hosted release binaries in parallel
   # with the test fan-out; the single need is native_addons, whose artifact
   # supplies their addons. Darwin builds live in release_binary_darwin so
   # they start at release_metadata time instead. Publishing (npm leaves,
   # GitHub release, core npm) is gated on release_gate downstream.
''',
    '''   # Builds (does not publish) the Linux-hosted release binaries in parallel
   # with the test fan-out; the single need is native_addons, whose artifact
   # supplies their addons. Darwin builds live in release_binary_darwin so
   # they start at release_metadata time instead. GitHub release publication
   # is gated on release_gate downstream.
''',
    "release binary comment",
)

darwin_upload_start = source.find(
    '''         # Darwin addons exist only on these runners; export them so
         # release_native_leaves can publish every leaf package after the
         # validation gate. Non-darwin leaves reuse the native-addons artifact.
         - name: Upload darwin native addon artifact
'''
)
if darwin_upload_start < 0:
    raise SystemExit("Darwin native leaf upload step was not found")
darwin_upload_end = source.find(
    "         - name: Upload release binary artifact\n",
    darwin_upload_start,
)
if darwin_upload_end < 0:
    raise SystemExit("Darwin release binary upload step was not found")
source = source[:darwin_upload_start] + source[darwin_upload_end:]

strip_comment_before_job(
    "release_native_leaves",
    "   # Publishes the five @oh-my-pi/pi-natives-<tag> leaf packages once\n",
)
strip_comment_before_job(
    "release_brew",
    "   # Regenerate the Homebrew tap formula (can1357/homebrew-tap) from the freshly\n",
)
remove_job("release_native_leaves")
remove_job("release_npm")
remove_job("release_brew")

forbidden = [
    "skip_npm",
    "release_native_leaves:",
    "release_npm:",
    "release_brew:",
    "Publish native leaf packages",
    "Publish to npm",
    "Update Homebrew tap",
    "NPM_TOKEN",
    "HOMEBREW_TAP_DEPLOY_KEY",
    "ci:release:publish-native-leaf",
    "ci:release:publish\n",
    "ci-update-brew-formula.ts",
    "native-addons-darwin-*",
]
remaining = [value for value in forbidden if value in source]
if remaining:
    raise SystemExit(f"Publisher references remain: {remaining}")
for required in ("   release_github:\n", "   release_github_verify:\n"):
    if required not in source:
        raise SystemExit(f"Required GitHub release job disappeared: {required.strip()}")

path.write_text(source.rstrip() + "\n")
