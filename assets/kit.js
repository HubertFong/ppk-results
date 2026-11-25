// The kit shop's live count (FEAT-040 S1, #291).
// Reads each item's paid count from shop_item_counts() (S2, #292) and fills
// the built page: the count, the meter, "Going ahead" or "Needs N more", and
// the price step reached. Any failure leaves the built page as it is.
(function () {
  "use strict";

  // The step a paid count has reached: the last row whose "from" it meets.
  function stepReached(rows, paid) {
    var at = 0;
    for (var i = 0; i < rows.length; i++) {
      if (paid >= rows[i].from) at = i;
    }
    return at;
  }

  function moneyText(sen) {
    var whole = Math.floor(sen / 100), cents = sen % 100;
    return "RM" + whole + (cents ? "." + (cents < 10 ? "0" : "") + cents : "");
  }

  var api = { stepReached: stepReached, moneyText: moneyText };
  // Under Node, for the tests: the functions above and nothing else.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var live = document.getElementById("kit-live");
  if (!live || !window.fetch) return;

  function fill(card, paid) {
    var go = parseInt(card.getAttribute("data-go"), 10);
    var count = card.querySelector(".kit-count");
    if (!count || !(go > 0)) return;
    count.querySelector(".kit-paid").textContent = paid + " paid";
    count.querySelector(".kit-meter span").style.width = Math.min(100, Math.round(paid / go * 100)) + "%";
    count.querySelector(".kit-chip").textContent = paid >= go ? "Going ahead" : "Needs " + (go - paid) + " more";
    count.hidden = false;

    var items = card.querySelectorAll(".kit-steps li");
    if (!items.length) return;
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      rows.push({ from: parseInt(items[i].getAttribute("data-from"), 10),
                  price: parseInt(items[i].getAttribute("data-price"), 10) });
      items[i].classList.remove("now");
    }
    var at = stepReached(rows, paid);
    items[at].classList.add("now");
    var next = card.querySelector(".kit-next");
    if (next && at + 1 < rows.length) {
      next.textContent = "· " + (rows[at + 1].from - paid) + " more for " + moneyText(rows[at + 1].price);
      next.hidden = false;
    }
  }

  var url = live.getAttribute("data-supabase-url").replace(/\/+$/, "") + "/rest/v1/rpc/shop_item_counts";
  fetch(url, {
    method: "POST",
    headers: { apikey: live.getAttribute("data-supabase-key"),
               "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_round: live.getAttribute("data-round") })
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (rows) {
    if (!Array.isArray(rows)) return;
    // Check every card first, so a page that is missing a part is left
    // whole rather than half filled.
    var cards = document.querySelectorAll(".kit-card");
    var plan = [];
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].querySelector(".kit-count .kit-paid") || !cards[i].querySelector(".kit-meter span")
          || !cards[i].querySelector(".kit-chip")) return;
      rows.forEach(function (row) {
        if (row && row.item === cards[i].getAttribute("data-item") && typeof row.paid === "number"
            && row.paid >= 0) plan.push([cards[i], Math.floor(row.paid)]);
      });
    }
    plan.forEach(function (p) { fill(p[0], p[1]); });
  }).catch(function () {
    // No count yet (S2 not live) or no connection: keep the built page.
  });
})();
