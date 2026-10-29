// npm run smoke: starts the real app with its window hidden and the input helper in DRY mode
// (it never moves your mouse or types), in a throwaway data folder. Screenshots land in the folder it prints.
// Set AP_SMOKE_NO_AI=1 to skip the Ollama check.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = mkdtempSync(join(tmpdir(), 'ap-smoke-'));
const out = process.env.AP_SMOKE_OUT || join(data, 'shots');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, AP_HIDDEN: '1', AP_SMOKE: '1', AP_DRY_INPUT: '1', AP_DATA_DIR: data, AP_SMOKE_OUT: out } });
const timer = setTimeout(() => { console.error('smoke test timed out'); child.kill(); process.exit(1); }, 4 * 60e3);
child.on('close', code => { clearTimeout(timer); console.log(code === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED', '— screenshots in', out); process.exit(code ?? 1); });
