/* Meherluna checkout helper.
   Add to your site:  <script src="https://YOUR-API-DOMAIN/client/checkout.js"></script>
   Give your three <select> elements these ids: ml-division, ml-district, ml-upazila
   Then use window.mlShop.getProducts / getCharge / placeOrder. */
(function () {
  var BASE = new URL(document.currentScript.src).origin;
  var LOC = null;

  function fill(sel, list, placeholder) {
    sel.innerHTML = '';
    var o = document.createElement('option');
    o.value = ''; o.textContent = placeholder; sel.appendChild(o);
    list.forEach(function (x) {
      var e = document.createElement('option');
      e.value = x; e.textContent = x; sel.appendChild(e);
    });
    sel.disabled = !list.length;
  }

  function cookie(n) {
    var m = document.cookie.match('(?:^|; )' + n + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : undefined;
  }

  function json(r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error(j.error || 'Request failed');
      return j;
    });
  }

  function initPicker() {
    var d = document.getElementById('ml-division');
    var di = document.getElementById('ml-district');
    var u = document.getElementById('ml-upazila');
    if (!d || !di || !u) return;
    fetch(BASE + '/api/locations').then(json).then(function (data) {
      LOC = data;
      fill(d, Object.keys(LOC), 'Select division');
      fill(di, [], 'Select district');
      fill(u, [], 'Select upazila');
      d.addEventListener('change', function () {
        fill(di, d.value ? Object.keys(LOC[d.value]) : [], 'Select district');
        fill(u, [], 'Select upazila');
        document.dispatchEvent(new CustomEvent('ml:district', { detail: '' }));
      });
      di.addEventListener('change', function () {
        fill(u, d.value && di.value ? LOC[d.value][di.value] : [], 'Select upazila');
        // Listen to this event to refresh the delivery charge shown in the cart
        document.dispatchEvent(new CustomEvent('ml:district', { detail: di.value }));
      });
    });
  }

  window.mlShop = {
    getProducts: function () { return fetch(BASE + '/api/products').then(json); },
    getCharge: function (district, subtotal) {
      return fetch(BASE + '/api/delivery-charge?district=' + encodeURIComponent(district) + '&subtotal=' + (subtotal || 0)).then(json);
    },
    // payload: { name, phone, division, district, upazila, address, note, items:[{productId, qty}] }
    placeOrder: function (payload) {
      payload.fbp = cookie('_fbp');
      payload.fbc = cookie('_fbc');
      return fetch(BASE + '/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(json).then(function (res) {
        if (window.mlTrack) window.mlTrack.purchase(res.orderId, res.total, res.contents);
        return res;
      });
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPicker);
  else initPicker();
})();
