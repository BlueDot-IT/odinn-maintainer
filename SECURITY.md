# Internal security reporting

`odinn-maintainer` is an internal BlueDot IT control-plane repository. Do not
open a public issue for suspected credential exposure, workflow-permission
bypass, prompt-boundary failure, or unsafe autonomous mutation.

Report those findings privately to the BlueDot IT repository owner. Include the
affected commit, workflow run, reproduction conditions, and the smallest
evidence needed to validate the report. Never include tokens, OAuth records,
artifact-encryption keys, or unredacted private repository content.

Changes to actions, maintainer policy, OAuth transport, automation guards, or
reusable workflows require owner review and passing required checks before
merge.
