/* The PPK member rides page: the upcoming group rides, with sign-up and
 * cancel for signed-in members.
 *
 * A classic script, loaded at the end of the body by site_rides.py, so every
 * element below already exists when it runs. Its only dependency is the
 * global `supabase` from the pinned supabase-js tag on the same page.
 * Config comes from #rides-root's data attributes, never from inline text.
 */
(function () {
  "use strict";

  // Exactly the columns 0006_rides.sql grants. select("*") is refused,
  // because created_by is not readable.
  var RIDE_SELECT =
    "id, title, meeting_point, meeting_map_link, meet_at, depart_at, " +
    "route_link, distance_m, climbing_m, regroup_policy, pace_note, " +
    "capacity, signup_deadline, status";

  // An organizer's own session can read drafts as well, so the list names the
  // three statuses a rider may see: a draft must never show here.
  var VISIBLE_STATUSES = ["published", "postponed", "cancelled"];

  var rootEl = document.getElementById("rides-root");
  var sessionEl = document.getElementById("rides-session");
  var loadingEl = document.getElementById("rides-loading");
  var listEl = document.getElementById("rides-list");
  var emptyEl = document.getElementById("rides-empty");
  var statusEl = document.getElementById("rides-status");
  var errorEl = document.getElementById("rides-error");

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);

  var currentUser = null; // the signed-in member, or null
  var loadedUserId;       // whose session the list holds; undefined until the first report
  var listVersion = 0;    // bumped on every rides reload, drops stale replies

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Nodes are built from data with textContent and properties, never markup.
  function textBlock(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function actionButton(label, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  // One paragraph for whatever went wrong. A refusal from join_ride() or
  // cancel_ride_signup() is shown as the server's own message: it names the
  // rule that was hit, which this page cannot word better.
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  // The server words a refusal as "join_ride: this ride is full"; the member
  // needs the reason, not the function's name.
  function refusalText(message) {
    var reason = String(message || "something went wrong").replace(/^[a-z_]+: /, "");
    reason = reason.charAt(0).toUpperCase() + reason.slice(1);
    return /[.!?]$/.test(reason) ? reason : reason + ".";
  }

  // --------------------------------------------------------------- session

  // Where to come back to after signing in: this page, query string and all.
  function returnToHref() {
    return "account.html?returnTo=" + encodeURIComponent(location.pathname + location.search);
  }

  function showSessionLine(user) {
    clearChildren(sessionEl);
    if (user) {
      sessionEl.textContent = "You're signed in as " + (user.email || "");
      return;
    }
    sessionEl.appendChild(document.createTextNode("Sign in on your account page to sign up: "));
    var link = document.createElement("a");
    link.id = "rides-signin-link";
    link.href = returnToHref();
    link.textContent = "sign in";
    sessionEl.appendChild(link);
  }

  function applySession(session) {
    var user = session ? session.user : null;
    currentUser = user;
    showSessionLine(user);
    // getSession() and INITIAL_SESSION report the same session, so only a
    // change of member re-reads the rides.
    var userId = user ? user.id : null;
    if (userId === loadedUserId) return;
    loadedUserId = userId;
    // A result line for the member who just left is not this visitor's.
    statusEl.textContent = "";
    loadRides();
  }

  // ---------------------------------------------------------- ride details

  function formatTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      // An unreadable timestamp still says something rather than nothing.
      return value === null || value === undefined ? "" : String(value);
    }
    return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function isBefore(value) {
    var date = new Date(value);
    return !Number.isNaN(date.getTime()) && Date.now() < date.getTime();
  }

  function distanceLine(ride) {
    if (ride.distance_m === null || ride.distance_m === undefined) return null;
    return textBlock("div", "Distance: " + (ride.distance_m / 1000).toFixed(1) + " km");
  }

  function climbingLine(ride) {
    if (ride.climbing_m === null || ride.climbing_m === undefined) return null;
    return textBlock("div", "Climbing: " + ride.climbing_m + " m");
  }

  // A "Label: value" line, or null when the ride has nothing to say there.
  function textLine(label, value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    return textBlock("div", label + ": " + value);
  }

  // A link only for a URL the browser reads as http(s): a stored javascript:
  // or data: URL would otherwise become a live link.
  function externalLink(url, label) {
    if (typeof url !== "string" || url === "") return null;
    var protocol;
    try {
      protocol = new URL(url).protocol;
    } catch (error) {
      return null;
    }
    if (protocol !== "http:" && protocol !== "https:") return null;
    var link = document.createElement("a");
    link.href = url;
    link.textContent = label;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    return link;
  }

  function meetLine(ride) {
    var line = textBlock("div",
      "Meet: " + formatTime(ride.meet_at) + " at " + (ride.meeting_point || ""));
    var mapLink = externalLink(ride.meeting_map_link, "Map");
    if (mapLink) {
      line.appendChild(document.createTextNode(" "));
      line.appendChild(mapLink);
    }
    return line;
  }

  function routeLine(ride) {
    var routeLink = externalLink(ride.route_link, "Route");
    if (!routeLink) return null;
    var line = document.createElement("div");
    line.appendChild(routeLink);
    return line;
  }

  function placesLine(ride, taken) {
    // An organizer can lower the capacity below the places already taken, so
    // the difference is never shown as a negative number.
    var left = Math.max(0, ride.capacity - taken);
    return textBlock("div", "Places left: " + left + " of " + ride.capacity);
  }

  // -------------------------------------------------------------- actions

  // A member whose earlier sign-up was cancelled is signing up again: the row
  // is still there, and join_ride() sends a rejoin to the back of the queue.
  function joinButton(ride, signupStatus) {
    var label = signupStatus === "cancelled" ? "Sign up again" : "Sign up";
    var button = actionButton(label, function () { joinRide(ride, button); });
    return button;
  }

  function joinRide(ride, button) {
    clearError();
    button.disabled = true;
    client.rpc("join_ride", { ride_id: ride.id }).then(function (res) {
      button.disabled = false;
      if (res.error) {
        showError(refusalText(res.error.message));
        return;
      }
      // 'confirmed', or 'already_confirmed' for a member who was in already.
      statusEl.textContent = res.data === "already_confirmed"
        ? "You were already signed up."
        : "You're signed up.";
      loadRides();
    });
  }

  function cancelButton(ride) {
    var button = actionButton("Cancel my place", function () { cancelSignup(ride, button); });
    return button;
  }

  function cancelSignup(ride, button) {
    if (!window.confirm("Cancel your place on this ride?")) return;
    clearError();
    button.disabled = true;
    client.rpc("cancel_ride_signup", { ride_id: ride.id }).then(function (res) {
      button.disabled = false;
      if (res.error) {
        showError(refusalText(res.error.message));
        return;
      }
      // 'cancelled', or 'not_signed_up' when there was no confirmed place.
      statusEl.textContent = res.data === "not_signed_up"
        ? "You weren't signed up."
        : "Your place is cancelled.";
      loadRides();
    });
  }

  // The one thing this member can do about this ride, or a line saying why
  // there is nothing to do. Only a published ride takes sign-ups: a postponed
  // ride may still run, but it cannot be joined, and a member already on it
  // keeps their place and can still cancel it.
  function actionLine(ride, signupStatus, placesTaken) {
    if (ride.status === "cancelled") return null;
    var line = document.createElement("div");
    line.className = "ride-actions";
    if (signupStatus === "confirmed") {
      line.appendChild(textBlock("span", "You're signed up."));
      if (isBefore(ride.depart_at)) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(cancelButton(ride));
      }
      return line;
    }
    if (ride.status !== "published") return null;
    if (!isBefore(ride.signup_deadline)) {
      line.appendChild(textBlock("span", "Sign-up has closed."));
      return line;
    }
    if (!currentUser) {
      var signInLink = document.createElement("a");
      signInLink.href = returnToHref();
      signInLink.textContent = "Sign in to sign up";
      line.appendChild(signInLink);
      return line;
    }
    // A count that could not be read is not proof the ride is full:
    // join_ride() counts again under the ride lock, and refuses with a
    // message this page shows.
    if (placesTaken !== null && placesTaken >= ride.capacity) {
      line.appendChild(textBlock("span", "This ride is full."));
      return line;
    }
    line.appendChild(joinButton(ride, signupStatus));
    return line;
  }

  // ------------------------------------------------------------- rides list

  function appendDetail(item, line) {
    if (line) item.appendChild(line);
  }

  function rideHeading(ride) {
    var heading = document.createElement("div");
    heading.appendChild(textBlock("strong", ride.title));
    if (ride.status === "postponed" || ride.status === "cancelled") {
      heading.appendChild(document.createTextNode(" "));
      heading.appendChild(textBlock("span",
        ride.status === "postponed" ? "Postponed" : "Cancelled", "badge"));
    }
    return heading;
  }

  function rideItem(ride, signupStatus, version) {
    var item = document.createElement("li");
    item.appendChild(rideHeading(ride));
    appendDetail(item, meetLine(ride));
    appendDetail(item, textBlock("div", "Departs: " + formatTime(ride.depart_at)));
    appendDetail(item, routeLine(ride));
    appendDetail(item, distanceLine(ride));
    appendDetail(item, climbingLine(ride));
    appendDetail(item, textLine("Regroup", ride.regroup_policy));
    appendDetail(item, textLine("Pace", ride.pace_note));
    var closesLine = textBlock("div", "Sign-up closes: " + formatTime(ride.signup_deadline));
    item.appendChild(closesLine);
    // The places count is a second read, and the action line waits for it:
    // the count chooses between a sign-up button and "This ride is full."
    client.rpc("ride_places_taken", { ride_id: ride.id }).then(function (res) {
      // A reply for a ride that has been reloaded away is dropped.
      if (version !== listVersion) return;
      var taken = null;
      if (res.error) {
        showError("Couldn't read the places taken: " + res.error.message);
      } else {
        taken = Number(res.data || 0);
      }
      if (taken !== null) item.insertBefore(placesLine(ride, taken), closesLine);
      var actions = actionLine(ride, signupStatus, taken);
      if (actions) item.appendChild(actions);
    });
    return item;
  }

  function appendRides(rides, statuses, version) {
    rides.forEach(function (ride) {
      listEl.appendChild(rideItem(ride, statuses[ride.id] || null, version));
    });
  }

  // The member's own sign-ups, by ride id. RLS limits this read to their own
  // rows: another rider's sign-up cannot come back, whatever is asked for.
  function loadSignupStatuses(rides, version) {
    var ids = rides.map(function (ride) { return ride.id; });
    client.from("session_signups")
      .select("session_id, status")
      .in("session_id", ids)
      .then(function (res) {
        if (version !== listVersion) return;
        if (res.error) {
          // The rides themselves still show: a stale guess about a sign-up is
          // corrected by join_ride(), which refuses with a message.
          showError("Couldn't read your sign-ups: " + res.error.message);
        }
        var statuses = {};
        (res.data || []).forEach(function (row) {
          statuses[row.session_id] = row.status;
        });
        appendRides(rides, statuses, version);
      });
  }

  function loadRides() {
    clearError();
    listVersion += 1;
    var version = listVersion;
    clearChildren(listEl);
    emptyEl.hidden = true;
    loadingEl.hidden = false;
    client.from("sessions")
      .select(RIDE_SELECT)
      .in("status", VISIBLE_STATUSES)
      .gte("depart_at", new Date().toISOString())
      .order("meet_at", { ascending: true })
      .then(function (res) {
        if (version !== listVersion) return;
        loadingEl.hidden = true;
        if (res.error) {
          showError("Couldn't load the rides: " + res.error.message);
          return;
        }
        var rides = res.data || [];
        emptyEl.hidden = rides.length > 0;
        if (rides.length === 0) return;
        // A visitor who is not signed in has no sign-ups to look up.
        if (!currentUser) {
          appendRides(rides, {}, version);
          return;
        }
        loadSignupStatuses(rides, version);
      });
  }

  // ---------------------------------------------------------------- wiring

  client.auth.getSession().then(function (res) {
    applySession(res.data.session);
  });
  client.auth.onAuthStateChange(function (event, session) {
    applySession(session);
  });
})();
