const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

// Language configurations
// Each language defines:
// - image:   which Docker image to use
// - filename: what to name the code file inside the container
// - cmd:     the command to run inside the container
const LANGUAGES = {
  python: {
    image:    'python:3.12-slim',
    filename: 'code.py',
    cmd:      ['python', '-u', '/sandbox/code.py'],
    // -u flag = unbuffered output so we see it in real time
  },
  javascript: {
    image:    'node:20-slim',
    filename: 'code.js',
    cmd:      ['node', '/sandbox/code.js'],
  },
cpp: {
  image:    'gcc:13',
  filename: 'code.cpp',
  cmd:      ['sh', '-c', 'cd /sandbox && g++ -o /sandbox/code /sandbox/code.cpp && chmod +x /sandbox/code && /sandbox/code'],
},
  java: {
    image:    'openjdk:21-slim',
    filename: 'Main.java',
    cmd:      ['sh', '-c', 'cd /sandbox && javac Main.java && java Main'],
  }
};

// Security limits applied to every container
const SECURITY_FLAGS = [
  '--rm',                    // destroy container after it exits
  '--network', 'none',       // no internet access whatsoever
  '--memory', '128m',        // 128MB RAM maximum
  '--memory-swap', '128m',   // no swap memory either
  '--cpus', '0.5',           // half a CPU core maximum
  '--read-only',             // filesystem is read-only
  '--tmpfs', '/sandbox:size=10m,exec', // tiny writable scratch space
  '--user', '1000:1000',     // run as non-root user
];

const TIMEOUT_MS = 10000; // 10 second maximum execution time

/**
 * Execute code in a sandboxed Docker container
 *
 * @param {string} code      - the source code to execute
 * @param {string} language  - 'python' | 'javascript' | 'cpp' | 'java'
 * @param {function} onOutput - called with each line of output as it arrives
 * @returns {Promise<{exitCode: number, timedOut: boolean}>}
 */
function executeCode(code, language, onOutput) {
  return new Promise((resolve) => {
    const config = LANGUAGES[language];

    if (!config) {
      onOutput(`[Error] Unsupported language: ${language}\n`);
      resolve({ exitCode: 1, timedOut: false });
      return;
    }

    // Write code to a temp file on the HOST machine
    // Docker will mount this file into the container
    //
    // Each execution gets its own unique scratch directory (mkdtemp
    // appends a random suffix) instead of a fixed path per language.
    // With a fixed path, two concurrent runs of the same language —
    // e.g. from two different rooms — would share one file on disk:
    // whichever run wrote second would silently overwrite the first
    // run's code before its container even read it, and the two runs'
    // cleanup (unlink) could delete the file out from under each other.
    const runDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-run-'));
    const tmpFile = path.join(runDir, config.filename);
    fs.writeFileSync(tmpFile, code, 'utf8');

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

    // Build the full docker run command
    const dockerArgs = [
      'run',
      ...SECURITY_FLAGS,
      // Mount the temp file as read-only inside /sandbox
      '--volume', `${tmpFile}:/sandbox/${config.filename}:ro`,
      config.image,
      ...config.cmd
    ];

    onOutput(`[Running ${language} code...]\n`);

    // Spawn docker as a child process
    // This is non-blocking — your Node.js server keeps handling
    // other WebSocket connections while the code executes
    const docker = spawn('docker', dockerArgs);

    let timedOut = false;

    // Kill the container after TIMEOUT_MS seconds
    // Prevents infinite loops from running forever
    const timeout = setTimeout(() => {
      timedOut = true;
      docker.kill('SIGKILL');
      onOutput(`\n[Error] Execution timed out after ${TIMEOUT_MS / 1000} seconds\n`);
    }, TIMEOUT_MS);

    // Stream stdout in real time
    // Each chunk arrives as the program prints it
    // This is why Python uses -u (unbuffered) flag
    docker.stdout.on('data', (chunk) => {
      onOutput(chunk.toString());
    });

    // Stream stderr in real time
    // Syntax errors, runtime exceptions, compiler errors
    docker.stderr.on('data', (chunk) => {
      onOutput(chunk.toString());
    });

    // Container finished
    docker.on('close', (exitCode) => {
      clearTimeout(timeout);
      cleanup();

      if (!timedOut) {
        onOutput(`\n[Exited with code ${exitCode}]\n`);
      }

      resolve({ exitCode, timedOut });
    });

    // Docker itself failed to start
    docker.on('error', (err) => {
      clearTimeout(timeout);
      cleanup();
      onOutput(`[Error] Failed to start Docker: ${err.message}\n`);
      onOutput('Is Docker Desktop running?\n');
      resolve({ exitCode: 1, timedOut: false });
    });
  });
}

module.exports = { executeCode };