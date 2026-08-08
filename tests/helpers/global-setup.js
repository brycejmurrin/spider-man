// @ts-check
/**
 * Playwright globalSetup — pings the dev server before any test runs.
 *
 * If the server doesn't respond within ~10 seconds the run aborts with a
 * clear message instead of letting dozens of specs fail with cryptic
 * net::ERR_CONNECTION_REFUSED errors.
 */
import http from 'http';

/**
 * @param {import('@playwright/test').FullConfig} config
 */
async function globalSetup(config) {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? 'http://localhost:3456';

  const delays = [200, 400, 800, 1600, 3200]; // ~6 s total ceiling per retry sequence
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await ping(baseURL, 5000);
      console.log(`✓ dev server ready at ${baseURL}`);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length - 1) {
        await wait(delays[attempt]);
      }
    }
  }

  throw new Error(
    `Dev server did not respond at ${baseURL} after 5 attempts (~10 s).\n` +
    `Use the npm test scripts so a server and free port are managed automatically.\n` +
    `Underlying error: ${lastError?.message ?? lastError}`
  );
}

/**
 * Resolves if the server returns any HTTP response within `timeoutMs`,
 * rejects otherwise.
 * @param {string} baseURL
 * @param {number} timeoutMs
 */
function ping(baseURL, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseURL, (res) => {
      res.resume(); // drain so the socket is released
      resolve(res.statusCode);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timed out after ${timeoutMs} ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default globalSetup;
