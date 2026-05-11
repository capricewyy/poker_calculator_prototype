// ──────────────────────────────────────────
//  MAIN — init + renderAll + inline-handler wiring shim
// ──────────────────────────────────────────
import { load } from './state.js';
import { registerRenderAll } from './refresh.js';

import { showTab, updateTabBadges } from './ui/tabs.js';
import { saveChipRate, clearAll, updateRateDisplay } from './ui/setup.js';
import { addPlayer, removePlayer, renderPlayers, updateSelects } from './ui/players.js';
import {
  addFamily, removeFamily, removeFamilyMember, addFamilyMember,
  renderFamilies,
} from './ui/families.js';
import { addBuyin, removeBuyin, renderBuyins } from './ui/buyins.js';
import {
  renderDinnerForm, setDinnerFormParticipants, updateDinnerCustomTotal,
  addDinner, removeDinner, renderDinner,
} from './ui/dinner.js';
import { setCashout, clearCashout, renderCashout } from './ui/cashout.js';
import { renderSettle, copySettlement } from './ui/settle.js';

// ──────────────────────────────────────────
//  RENDER ALL
// ──────────────────────────────────────────
function renderAll() {
  updateRateDisplay();
  updateSelects();
  renderPlayers();
  renderFamilies();
  renderBuyins();
  renderDinner();
  renderCashout();
  renderSettle();
  updateTabBadges();
}

// Register renderAll with the refresh shim so UI modules can call it
// without importing main.js back (which would be a circular import).
registerRenderAll(renderAll);

// ──────────────────────────────────────────
//  INLINE HANDLER EXPOSURE
//  The HTML uses inline `onclick=`/`onchange=`/`oninput=`/`onkeydown=`
//  attributes (preserved from the prototype). ES modules don't put names
//  on `window` by default, so we expose every function referenced by
//  inline attributes here. This is the ONLY place that touches `window`.
// ──────────────────────────────────────────
window.showTab                   = showTab;
window.saveChipRate              = saveChipRate;
window.clearAll                  = clearAll;
window.addPlayer                 = addPlayer;
window.removePlayer              = removePlayer;
window.addBuyin                  = addBuyin;
window.removeBuyin               = removeBuyin;
window.addFamily                 = addFamily;
window.removeFamily              = removeFamily;
window.removeFamilyMember        = removeFamilyMember;
window.addFamilyMember           = addFamilyMember;
window.renderDinnerForm          = renderDinnerForm;
window.setDinnerFormParticipants = setDinnerFormParticipants;
window.updateDinnerCustomTotal   = updateDinnerCustomTotal;
window.addDinner                 = addDinner;
window.removeDinner              = removeDinner;
window.setCashout                = setCashout;
window.clearCashout              = clearCashout;
window.renderSettle              = renderSettle;
window.copySettlement            = copySettlement;

// ──────────────────────────────────────────
//  INIT
// ──────────────────────────────────────────
load();
renderAll();
