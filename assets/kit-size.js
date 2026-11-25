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

  // The labels nearest to v on one axis of a chart: one index, or two when
  // v sits exactly halfway between two labels. Beyond the first or last
  // label by more than half a step, the chart says nothing.
  function nearest(axis, v) {
    if (typeof v !== "number" || !isFinite(v) || !axis.length) return [];
    var n = axis.length;
    var first = n > 1 ? axis[1] - axis[0] : 0, last = n > 1 ? axis[n - 1] - axis[n - 2] : 0;
    if (v < axis[0]) return axis[0] - v <= first / 2 ? [0] : [];
    if (v > axis[n - 1]) return v - axis[n - 1] <= last / 2 ? [n - 1] : [];
    for (var i = 0; i < n; i++) {
      if (v === axis[i]) return [i];
      if (v < axis[i + 1]) {
        var mid = (axis[i] + axis[i + 1]) / 2;
        return v < mid ? [i] : v > mid ? [i + 1] : [i, i + 1];
      }
    }
    return [];
  }

  function inOrder(found, sizes) {
    return found.filter(function (s, i) { return found.indexOf(s) === i; })
                .sort(function (a, b) { return sizes.indexOf(a) - sizes.indexOf(b); });
  }

  // The chart's sizes for a height and weight: [] off the chart or in a gap.
  function lookup(chart, height, weight, sizes) {
    var found = [];
    nearest(chart.heights, height).forEach(function (r) {
      nearest(chart.weights, weight).forEach(function (c) {
        if (chart.cells[r][c]) found.push(chart.cells[r][c]);
      });
    });
    return inOrder(found, sizes);
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
    return chart ? lookup(chart, input.height, input.weight, item.sizes) : [];
  }

  function words(found) {
    return found.join(" or ");
  }

  var api = { nearest: nearest, lookup: lookup, fromFit: fromFit, fromShoe: fromShoe,
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
