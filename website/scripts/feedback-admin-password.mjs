import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';
import { Writable } from 'node:stream';
import { hashFeedbackAdminPassword } from '../feedback-admin.mjs';

const input = createInterface({
  input: stdin,
  terminal: Boolean(stdin.isTTY),
  output: new Writable({ write(_chunk, _encoding, done) { done(); } }),
});

if (stdin.isTTY) stderr.write('管理员密码（输入时隐藏）：');
try {
  for await (const password of input) {
    if (stdin.isTTY) stderr.write('\n');
    stdout.write(`FEEDBACK_ADMIN_PASSWORD_HASH=${await hashFeedbackAdminPassword(password)}\n`);
    break;
  }
} catch (error) {
  stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  input.close();
}
