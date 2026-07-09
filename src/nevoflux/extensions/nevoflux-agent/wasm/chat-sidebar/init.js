import init, * as bindings from './chat-sidebar-6cd9013a13cb7a19.js';
const wasm = await init({ module_or_path: './chat-sidebar-6cd9013a13cb7a19_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));