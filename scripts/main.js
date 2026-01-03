const MODULE_ID = "trusted-roll-modifier";
const SETTING_MODE = "mode";

// Modes: "min", "low", "normal", "high", "max"
const MODES = ["min", "low", "normal", "high", "max"];

function isTrustedOnly() {
  // Exactly TRUSTED, not PLAYER, not ASSISTANT, not GM
  return game.user?.role === CONST.USER_ROLES.TRUSTED;
}

function getMode() {
  return game.settings.get(MODULE_ID, SETTING_MODE) ?? "normal";
}

function setMode(mode) {
  if (!MODES.includes(mode)) mode = "normal";
  return game.settings.set(MODULE_ID, SETTING_MODE, mode);
}

function applyMinMaxToEvalOptions(options = {}) {
  const mode = getMode();
  if (mode === "min") return { ...options, minimize: true, maximize: false };
  if (mode === "max") return { ...options, maximize: true, minimize: false };
  return options;
}

function upsertPanel() {
  if (!isTrustedOnly()) return;

  let el = document.getElementById("trm-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "trm-panel";
    el.className = "trm-panel";
    el.innerHTML = `
      <div class="trm-title">Roll Mode</div>
      <div class="trm-buttons">
        <button type="button" data-mode="min" title="Force minimum results">min</button>
        <button type="button" data-mode="low" title="Force disadvantage (roll twice, take lower) on every die">low</button>
        <button type="button" data-mode="normal" title="Normal rolls">normal</button>
        <button type="button" data-mode="high" title="Force advantage (roll twice, take higher) on every die">high</button>
        <button type="button" data-mode="max" title="Force maximum results">max</button>
      </div>
    `.trim();

    el.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("button[data-mode]");
      if (!btn) return;
      void setMode(btn.dataset.mode);
    });

    document.body.appendChild(el);
  }

  refreshPanelActiveState();
}

function refreshPanelActiveState() {
  const el = document.getElementById("trm-panel");
  if (!el) return;

  const mode = getMode();
  for (const btn of el.querySelectorAll("button[data-mode]")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
}

function installPatchesOnce() {
  if (!isTrustedOnly()) return;

  // Avoid double-patching on hot reloads
  const patchFlag = `${MODULE_ID}.__patched__`;
  if (globalThis[patchFlag]) return;
  globalThis[patchFlag] = true;

  // Patch Roll#evaluate and Roll#evaluateSync to enforce min/max via evaluation options.
  const RollCls = foundry?.dice?.Roll;
  if (RollCls?.prototype?.evaluate) {
    const originalEvaluate = RollCls.prototype.evaluate;
    RollCls.prototype.evaluate = function (options = {}) {
      options = applyMinMaxToEvalOptions(options);
      return originalEvaluate.call(this, options);
    };
  }

  if (RollCls?.prototype?.evaluateSync) {
    const originalEvaluateSync = RollCls.prototype.evaluateSync;
    RollCls.prototype.evaluateSync = function (options = {}) {
      options = applyMinMaxToEvalOptions(options);
      return originalEvaluateSync.call(this, options);
    };
  }

  // Patch DiceTerm#roll to implement low/high by rolling twice per die and choosing.
  const DiceTermCls = foundry?.dice?.terms?.DiceTerm;
  if (DiceTermCls?.prototype?.roll) {
    const originalDiceTermRoll = DiceTermCls.prototype.roll;

    DiceTermCls.prototype.roll = async function (options = {}) {
      const mode = getMode();

      // If min/max is active, let Foundry's own minimize/maximize path handle it.
      if (mode === "min" || mode === "max") {
        return originalDiceTermRoll.call(this, options);
      }

      // Only apply advantage/disadvantage in low/high mode.
      if (mode !== "low" && mode !== "high") {
        return originalDiceTermRoll.call(this, options);
      }

      // Respect explicit upstream requests (if some other code is already minimizing/maximizing).
      if (options?.minimize || options?.maximize) {
        return originalDiceTermRoll.call(this, options);
      }

      const r1 = await originalDiceTermRoll.call(this, options);
      const r2 = await originalDiceTermRoll.call(this, options);

      // Defensive: if a resolver returns undefined, fall back.
      if (typeof r1 !== "number") return r2;
      if (typeof r2 !== "number") return r1;

      return mode === "high" ? Math.max(r1, r2) : Math.min(r1, r2);
    };
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_MODE, {
    name: "Trusted Roll Modifier Mode",
    scope: "client",
    config: false,
    type: String,
    default: "normal",
    onChange: () => refreshPanelActiveState()
  });
});

Hooks.once("ready", () => {
  if (!isTrustedOnly()) return;

  installPatchesOnce();
  upsertPanel();

  // In case the DOM gets re-created by Foundry UI workflows, re-assert panel.
  Hooks.on("renderChatLog", () => upsertPanel());
  Hooks.on("renderSidebar", () => upsertPanel());
});
