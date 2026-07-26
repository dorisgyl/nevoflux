import init, * as bindings from './chat-sidebar-f44e771bbbf57b05.js';
const wasm = await init({ module_or_path: './chat-sidebar-f44e771bbbf57b05_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));