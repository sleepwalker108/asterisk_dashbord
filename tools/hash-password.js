// Генерує хеш пароля для config.json. Пароль вводиться з клавіатури і не потрапляє в історію команд.
import readline from 'node:readline';
import { hashPassword } from '../src/auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise((res) => {
  rl.stdoutMuted = false;
  rl.question(q, (a) => res(a));
  rl.stdoutMuted = true;
});
rl._writeToOutput = function (s) { if (!rl.stdoutMuted || s.includes('\n')) rl.output.write(s); };

const p1 = await ask('Новий пароль: ');
const p2 = await ask('\nЩе раз: ');
rl.close();
if (!p1 || p1 !== p2) { console.error('\nПаролі порожні або не збігаються'); process.exit(1); }
if (p1.length < 8) { console.error('\nПароль має бути щонайменше 8 символів'); process.exit(1); }
console.log('\n\nВставте цей рядок у config.json як "password":\n');
console.log(hashPassword(p1));
