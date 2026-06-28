import { describe, expect, it } from 'bun:test'
import * as fc from 'fast-check'
import { spawnSync } from 'node:child_process'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import { quote } from '../../src/utils/shell-quote.js'
import { whichSync } from '../../src/utils/which.js'

/**
 * Regression coverage for the `!` corruption bug, plus the round-trip
 * contract a shell quoter must satisfy.
 *
 * The npm `shell-quote` package this module replaces switched to a
 * double-quote + backslash strategy whenever an argument contained a single
 * quote, and in that mode it backslash-escaped `!`. The wrapper string is
 * only ever run through a non-interactive `<shell> -c`, where bash keeps
 * that backslash, so every `!` in the user command reached the program as
 * the two characters `\!`: heredoc-written `if (!x)` became unparseable
 * JavaScript, and `jq 'a != b'` / `awk '!seen[$0]++'` / `find ! -name`
 * filters were silently rewritten. The user command almost always contains
 * a `'`, so this fired on essentially every sandboxed command.
 */
describe('quote', () => {
  // The string-level tests are pure JS and run on every CI leg.
  it('never backslash-escapes ! (the shell-quote regression)', () => {
    // The embedded `'` is what pushed shell-quote into its buggy branch.
    const command = `node -e 'if (!ok) throw new Error("bad")'`
    const quoted = quote(['/bin/bash', '-c', command])
    expect(quoted).toContain('!ok')
    expect(quoted).not.toContain('\\!')
  })

  it('the assembled macOS wrapper never contains a backslash-bang', () => {
    // End to end through the real wrapper builder: the input has no `\!`,
    // and correct POSIX quoting never needs to introduce one.
    const wrapped = wrapCommandWithSandboxMacOS({
      command: `node -e 'if (!ok) throw new Error("bad")'`,
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: ['/tmp'], denyWithinAllow: [] },
    })
    expect(wrapped).toContain('!ok')
    expect(wrapped).not.toContain('\\!')
  })

  it('leaves shell-safe words bare and single-quotes the rest', () => {
    expect(quote(['env', 'A=b', '/usr/bin/sandbox-exec', '-p'])).toBe(
      'env A=b /usr/bin/sandbox-exec -p',
    )
    expect(quote([''])).toBe("''")
    expect(quote(['a b'])).toBe("'a b'")
    expect(quote(["don't"])).toBe(`'don'"'"'t'`)
  })

  // The round-trip contract: parsing the quoted string with a real POSIX
  // shell must yield exactly the original argument list. This is the test
  // that would have caught the `!` bug. It needs a `bash` on PATH.
  describe.skipIf(whichSync('bash') === null)(
    'round-trips through bash',
    () => {
      /**
       * Runs `bash -c` on `quote(['printf', '%s\0', ...args])` and splits the
       * NUL-delimited output back into an argument list. printf appends a
       * trailing NUL, hence the final slice.
       */
      function roundTrip(args: string[]): string[] {
        const result = spawnSync(
          'bash',
          ['-c', quote(['printf', '%s\\0', ...args])],
          {
            encoding: 'utf8',
          },
        )
        expect(result.status).toBe(0)
        return result.stdout.split('\0').slice(0, -1)
      }

      it('preserves every shell metacharacter byte for byte', () => {
        const args = [
          'if (!ok) { throw new Error("bad") }',
          'a != b',
          '!seen[$0]++',
          "don't",
          '$HOME `id` $(id)',
          '* ? [a-z] ~ # | & ; < > ( )',
          'back\\slash',
          'new\nline',
          'tab\there',
          '!',
          '',
        ]
        expect(roundTrip(args)).toEqual(args)
      })

      it('property: quote() round-trips any printable-ASCII argv', () => {
        fc.assert(
          fc.property(
            fc.array(fc.string(), { minLength: 1, maxLength: 6 }),
            args => {
              expect(roundTrip(args)).toEqual(args)
            },
          ),
          { numRuns: 60 },
        )
      })
    },
  )
})
