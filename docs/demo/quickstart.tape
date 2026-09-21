# NOTE: vhs 0.12.0 exits 0 and writes no file (charmbracelet/vhs#787); use 0.11.0.
# Renders the README hero GIF. From the repo root, after `pnpm install && pnpm build`:
#
#   vhs docs/demo/quickstart.tape
#
# Runs 8–12 seconds: scaffold, write one hand-written case against the sample
# workflow, and watch `run` catch the `??` gotcha. Works in a scratch directory
# so nothing in the checkout changes.

Output docs/demo/quickstart.gif

Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 520
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Hide
  Type 'alias workflow-test="node $PWD/packages/cli/dist/bin.js"' Enter
  Type "rm -rf /tmp/workflow-test-demo && mkdir -p /tmp/workflow-test-demo/workflows && cp docs/demo/signup.json /tmp/workflow-test-demo/workflows/ && cd /tmp/workflow-test-demo && clear" Enter
Show

Type "workflow-test init < /dev/null" Enter
Sleep 2s

Type "clear" Enter
Type "cp $OLDPWD/docs/demo/signup.test.yaml .workflow-test/tests/ && workflow-test run" Enter
Sleep 4s

Type "clear" Enter
Type "sed -i '' 's/profile.first_name ??/profile?.first_name ??/' workflows/signup.json   # the fix: optional chaining" Enter
Sleep 800ms
Type "workflow-test run" Enter
Sleep 4s
