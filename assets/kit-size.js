// The size finder on the kit page (#317). A member types height, weight,
// their 2025 jersey size and fit, and shoe size; each card and the order
// form then suggest a size per cut. The numbers stay in this browser
// (localStorage) until the member clears them. This script makes no network
// call of any kind, and never writes HTML.
(function () {
  "use strict";

  var KEY = "ppk-kit-size-finder";
  var FIELDS = ["height", "weight", "size2025", "fit", "shoe"];
  var SHIFT = { tight: 1, right: 0, loose: -1 };

  // How far a body may sit from a filled cell, in rows plus columns, and
  // still get a suggestion (Hubert, 25 Nov: the skinsuit tables fill only a
  // diagonal band).
  var REACH = 2;

  // Where v falls on one axis of a chart, in label steps: the nearest label,
  // or the two either side when v sits exactly halfway. Past either end the
  // end step carries on, so a body just off the table gets an index such as
  // -1 or n. Not a number: nothing.
  function place(axis, v) {
    if (typeof v !== "number" || !isFinite(v) || axis.length < 2) return [];
    var n = axis.length, f;
    if (v <= axis[0]) {
      f = -(axis[0] - v) / (axis[1] - axis[0]);
    } else if (v >= axis[n - 1]) {
      f = n - 1 + (v - axis[n - 1]) / (axis[n - 1] - axis[n - 2]);
    } else {
      for (var i = 0; v > axis[i + 1]; i++) { /* find the band v is in */ }
      f = i + (v - axis[i]) / (axis[i + 1] - axis[i]);
    }
    var low = Math.floor(f);
    if (f - low === 0.5) return [low, low + 1];
    return [Math.round(f)];
  }

  function inOrder(found, sizes) {
    return found.filter(function (s, i) { return found.indexOf(s) === i; })
                .sort(function (a, b) { return sizes.indexOf(a) - sizes.indexOf(b); });
  }

  // One size, or two that are next to each other. A wider spread gives the
  // size in its middle (or the middle two), never two sizes apart.
  function settle(found, sizes) {
    var at = found.map(function (s) { return sizes.indexOf(s); }).filter(function (i) { return i >= 0; });
    if (!at.length) return [];
    var lo = Math.min.apply(null, at), hi = Math.max.apply(null, at);
    if (hi - lo <= 1) return sizes.slice(lo, hi + 1);
    var mid = (lo + hi) / 2;
    return mid % 1 ? [sizes[Math.floor(mid)], sizes[Math.ceil(mid)]] : [sizes[mid]];
  }

  // The chart's sizes for a height and weight: the nearest filled cells, up
  // to REACH rows plus columns away. A gap or a body just off the table
  // borrows from its neighbours; further off, nothing.
  function lookup(chart, height, weight, sizes) {
    var rows = place(chart.heights, height), cols = place(chart.weights, weight);
    if (!rows.length || !cols.length) return [];
    var best = Infinity, found = [];
    chart.cells.forEach(function (line, r) {
      line.forEach(function (cell, c) {
        if (!cell) return;
        var d = Infinity;
        rows.forEach(function (ri) {
          cols.forEach(function (ci) { d = Math.min(d, Math.abs(r - ri) + Math.abs(c - ci)); });
        });
        if (d < best) { best = d; found = [cell]; } else if (d === best) { found.push(cell); }
      });
    });
    return best > REACH ? [] : settle(found, sizes);
  }

  // Race-fit items run one size up from the maker's chart, capped at the
  // largest size.
  function raceFit(found, sizes) {
    return inOrder(found.filter(function (s) { return sizes.indexOf(s) >= 0; }).map(function (s) {
      return sizes[Math.min(sizes.indexOf(s) + 1, sizes.length - 1)];
    }), sizes);
  }

  // A 2025 jersey that fit right is the size; tight moves one up, loose one down.
  function fromFit(sizes, size2025, fit) {
    var at = sizes.indexOf(size2025);
    if (at < 0 || !Object.prototype.hasOwnProperty.call(SHIFT, fit)) return null;
    return sizes[at + SHIFT[fit]] || null;
  }

  // A size on the edge of two ranges (39, 42) shows both, smallest first.
  function fromShoe(ranges, shoe, sizes) {
    if (typeof shoe !== "number" || !isFinite(shoe)) return [];
    return inOrder(ranges.filter(function (r) { return shoe >= r[0] && shoe <= r[1]; })
                         .map(function (r) { return r[2]; }), sizes);
  }

  // The suggested sizes for one item and cut, smallest first: [] for none.
  function suggest(item, cut, input, items) {
    input = input || {};
    if (item.fit_from_2025 && input.size2025 && input.fit) {
      var fitted = fromFit(item.sizes, input.size2025, input.fit);
      if (fitted) return [fitted];
    }
    var finder = item.size_finder;
    if (typeof finder === "string") {
      var other = (items || []).filter(function (i) { return i.code === finder; })[0];
      finder = other ? other.size_finder : null;
    }
    if (!finder) return [];
    if (finder.shoe) return fromShoe(finder.shoe, input.shoe, item.sizes);
    var chart = finder[cut];
    if (!chart) return [];
    var found = lookup(chart, input.height, input.weight, item.sizes);
    return item.race_fit ? raceFit(found, item.sizes) : found;
  }

  function words(found) {
    return found.join(" or ");
  }

  var api = { place: place, settle: settle, raceFit: raceFit, lookup: lookup, fromFit: fromFit, fromShoe: fromShoe,
              suggest: suggest, words: words, KEY: KEY };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var root = document.getElementById("kit-finder");
  if (!root) return;
  var data;
  try {
    data = JSON.parse(root.getAttribute("data-finder"));
  } catch (error) {
    return;
  }

  function read() {
    try {
      return JSON.parse(window.localStorage.getItem(KEY)) || {};
    } catch (error) {
      return {};
    }
  }

  function write(input) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(input));
    } catch (error) {
      // Private windows may refuse storage: the finder still works until reload.
    }
  }

  var boxes = {};
  FIELDS.forEach(function (f) { boxes[f] = document.getElementById("kit-f-" + f); });

  function current() {
    var input = {};
    FIELDS.forEach(function (f) {
      var box = boxes[f];
      if (!box || box.value === "") return;
      input[f] = box.type === "number" ? parseFloat(box.value) : box.value;
    });
    return input;
  }

  var input = read();
  FIELDS.forEach(function (f) { if (boxes[f] && input[f] != null) boxes[f].value = String(input[f]); });
  // Read back what the boxes hold: a stored size no longer in the list is dropped.
  input = current();

  // For the order form in kit-orders.js: the suggestion for one item and cut.
  window.PPKSizeFinder = {
    suggestFor: function (code, cut) {
      var item = data.items.filter(function (i) { return i.code === code; })[0];
      return item ? suggest(item, cut, input, data.items) : [];
    }
  };

  function show() {
    data.items.forEach(function (item) {
      var slot = document.querySelector('.kit-suggest[data-item="' + item.code + '"]');
      if (!slot) return;
      var parts = [];
      if (item.cuts.length) {
        item.cuts.forEach(function (cut) {
          var found = suggest(item, cut, input, data.items);
          if (found.length) parts.push(cut + " " + words(found));
        });
      } else {
        var found = suggest(item, null, input, data.items);
        if (found.length) parts.push(words(found));
      }
      slot.textContent = parts.length ? "Suggested: " + parts.join(" · ") : "";
      slot.hidden = !parts.length;
      // The race line only beside a size from the chart: a 2025 jersey is
      // already the race cut, so its size takes no step.
      var race = document.querySelector('.kit-race[data-item="' + item.code + '"]');
      var from2025 = item.fit_from_2025 && input.size2025 && input.fit && fromFit(item.sizes, input.size2025, input.fit);
      if (race) race.hidden = slot.hidden || !!from2025;
    });
    document.dispatchEvent(new Event("ppk-size-finder"));
  }

  FIELDS.forEach(function (f) {
    if (!boxes[f]) return;
    ["input", "change"].forEach(function (kind) {
      boxes[f].addEventListener(kind, function () {
        input = current();
        write(input);
        show();
      });
    });
  });
  var clearButton = document.getElementById("kit-f-clear");
  if (clearButton) {
    clearButton.addEventListener("click", function () {
      FIELDS.forEach(function (f) { if (boxes[f]) boxes[f].value = ""; });
      input = {};
      try {
        window.localStorage.removeItem(KEY);
      } catch (error) {
        // Nothing stored.
      }
      show();
    });
  }
  root.hidden = false;
  show();
})();
