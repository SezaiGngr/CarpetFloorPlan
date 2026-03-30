// wallDetection.js — Client-side pixel wall detection
// Runs BEFORE the AI call to provide structural context:
//   - Building outline (including L/T/U shapes)
//   - Wall segments with pixel positions
//   - Window vs T-wall gap classification
//   - Approximate pixels-per-meter from labeled dimensions

const DARK = 105
const MIN_LEN = 15
const MIN_THICK = 4
const MAX_GAP = 6
const ROW_SKIP = 7
const MERGE_TOL = 10
const CONNECT_TOL = 25
const MAX_IMG = 900

// ─── Main entry point ────────────────────────────────────────────────────────
// Pass an HTMLCanvasElement (or create one from an image).
// Returns: { hWalls, vWalls, outline, gapClassifications, envelope, imgW, imgH }

export function detectWallsFromCanvas(canvas) {
  var w = canvas.width, h = canvas.height
  var ctx = canvas.getContext('2d')
  var imageData = ctx.getImageData(0, 0, w, h)
  return detectWalls(imageData, w, h)
}

export function detectWallsFromImage(imgSrc) {
  return new Promise(function (resolve) {
    var img = new Image()
    img.onload = function () {
      var scale = img.width > MAX_IMG ? MAX_IMG / img.width : 1
      var c = document.createElement('canvas')
      c.width = img.width * scale
      c.height = img.height * scale
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      resolve(detectWallsFromCanvas(c))
    }
    img.src = imgSrc
  })
}

// ─── Core detection pipeline ─────────────────────────────────────────────────

function detectWalls(imageData, width, height) {
  var data = imageData.data

  // Step 1: Dark pixel mask
  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  // Step 2: Vertical thickness map (for horizontal wall detection)
  var vThick = new Uint8Array(width * height)
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      var t = 0
      for (var dy = -5; dy <= 5; dy++) {
        var ny = y + dy
        if (ny >= 0 && ny < height && mask[ny * width + x]) t++
      }
      vThick[y * width + x] = t
    }
  }

  // Step 3: Horizontal thickness map (for vertical wall detection)
  var hThick = new Uint8Array(width * height)
  for (var y2 = 0; y2 < height; y2++) {
    for (var x2 = 0; x2 < width; x2++) {
      if (!mask[y2 * width + x2]) continue
      var t2 = 0
      for (var dx = -5; dx <= 5; dx++) {
        var nx = x2 + dx
        if (nx >= 0 && nx < width && mask[y2 * width + nx]) t2++
      }
      hThick[y2 * width + x2] = t2
    }
  }

  // Step 4: Scan horizontal walls
  var hSegs = [], lastHY = -999
  for (var hy = 0; hy < height; hy++) {
    if (hy - lastHY < ROW_SKIP) continue
    var rs = -1, gap = 0, found = false
    for (var hx = 0; hx < width; hx++) {
      if (vThick[hy * width + hx] >= MIN_THICK) { if (rs === -1) rs = hx; gap = 0 }
      else if (rs !== -1) {
        gap++
        if (gap > MAX_GAP) {
          var e = hx - gap
          if (e - rs >= MIN_LEN) { hSegs.push({ x1: rs, y1: hy, x2: e, y2: hy }); found = true }
          rs = -1; gap = 0
        }
      }
    }
    if (rs !== -1) { var ex = width - 1 - gap; if (ex - rs >= MIN_LEN) { hSegs.push({ x1: rs, y1: hy, x2: ex, y2: hy }); found = true } }
    if (found) lastHY = hy
  }

  // Step 5: Scan vertical walls
  var vSegs = [], lastVX = -999
  for (var vx = 0; vx < width; vx++) {
    if (vx - lastVX < ROW_SKIP) continue
    var rs2 = -1, gap2 = 0, found2 = false
    for (var vy = 0; vy < height; vy++) {
      if (hThick[vy * width + vx] >= MIN_THICK) { if (rs2 === -1) rs2 = vy; gap2 = 0 }
      else if (rs2 !== -1) {
        gap2++
        if (gap2 > MAX_GAP) {
          var e2 = vy - gap2
          if (e2 - rs2 >= MIN_LEN) { vSegs.push({ x1: vx, y1: rs2, x2: vx, y2: e2 }); found2 = true }
          rs2 = -1; gap2 = 0
        }
      }
    }
    if (rs2 !== -1) { var ey = height - 1 - gap2; if (ey - rs2 >= MIN_LEN) { vSegs.push({ x1: vx, y1: rs2, x2: vx, y2: ey }); found2 = true } }
    if (found2) lastVX = vx
  }

  // Step 6–8: Merge, envelope, filter
  var mH = mergeSegments(hSegs, 'h', MERGE_TOL)
  var mV = mergeSegments(vSegs, 'v', MERGE_TOL)
  var env = findEnvelope(mH, mV)
  if (env) {
    mH = mH.filter(function (w) { return w.y1 >= env.top - 10 && w.y1 <= env.bottom + 10 })
    mV = mV.filter(function (w) { return w.x1 >= env.left - 10 && w.x1 <= env.right + 10 })
  }

  // Iterative connection filter (keeps long walls)
  mH = filterOneEnd(mH, mV, 'h', CONNECT_TOL, 50)
  mV = filterOneEnd(mV, mH, 'v', CONNECT_TOL, 50)
  mH = filterOneEnd(mH, mV, 'h', CONNECT_TOL, 50)

  // Solidity filter
  mH = filterBySolidity(mH, vThick, width, MIN_THICK, 0.4, 'h')
  mV = filterBySolidity(mV, hThick, width, MIN_THICK, 0.4, 'v')

  // Join collinear — WITH T-wall awareness via classifyGap
  mH = joinCollinear(mH, 'h', MERGE_TOL, 25, mask, width, height)
  mV = joinCollinear(mV, 'v', MERGE_TOL, 25, mask, width, height)

  // Close window gaps on boundary walls
  if (env) {
    mH = closeWindowGaps(mH, mV, env, 'h', 15, mask, width, height)
    mV = closeWindowGaps(mV, mH, env, 'v', 15, mask, width, height)
  }

  // Remove near-duplicates
  mH = removeNearbyDuplicates(mH, 'h', 20)
  mV = removeNearbyDuplicates(mV, 'v', 20)

  // Build outline description
  var outline = describeOutline(mH, mV, env, width, height)

  // Classify all gaps on boundary walls for reporting
  var gapClassifications = classifyAllBoundaryGaps(mH, mV, env, 15, mask, width, height)

  return {
    hWalls: mH, vWalls: mV,
    envelope: env, outline: outline,
    gapClassifications: gapClassifications,
    imgW: width, imgH: height
  }
}


// ─── Gap classification: window vs T-wall vs open ────────────────────────────

function classifyGap(mask, imgW, imgH, wallPos, gapStart, gapEnd, axis) {
  var WALL_HALF = 8, DEEP_SCAN = 25
  var gapLen = gapEnd - gapStart
  if (gapLen < 3) return 'noise'

  var thinLineRows = 0, thickRows = 0, emptyRows = 0, deepDarkTotal = 0, totalScanned = 0

  for (var g = gapStart + 1; g < gapEnd - 1; g++) {
    var nearDark = 0, deepDark = 0

    if (axis === 'h') {
      for (var dy = -WALL_HALF; dy <= WALL_HALF; dy++) {
        var sy = wallPos + dy
        if (sy >= 0 && sy < imgH && mask[sy * imgW + g]) nearDark++
      }
      for (var dy2 = WALL_HALF + 1; dy2 <= WALL_HALF + DEEP_SCAN; dy2++) {
        if (wallPos - dy2 >= 0 && mask[(wallPos - dy2) * imgW + g]) deepDark++
        if (wallPos + dy2 < imgH && mask[(wallPos + dy2) * imgW + g]) deepDark++
      }
    } else {
      for (var dx = -WALL_HALF; dx <= WALL_HALF; dx++) {
        var sx = wallPos + dx
        if (sx >= 0 && sx < imgW && mask[g * imgW + sx]) nearDark++
      }
      for (var dx2 = WALL_HALF + 1; dx2 <= WALL_HALF + DEEP_SCAN; dx2++) {
        if (wallPos - dx2 >= 0 && mask[g * imgW + (wallPos - dx2)]) deepDark++
        if (wallPos + dx2 < imgW && mask[g * imgW + (wallPos + dx2)]) deepDark++
      }
    }

    totalScanned++
    deepDarkTotal += deepDark
    if (nearDark === 0) emptyRows++
    else if (nearDark <= 4) thinLineRows++
    else thickRows++
  }

  if (totalScanned === 0) return 'noise'
  var thickRatio = thickRows / totalScanned
  var thinRatio = thinLineRows / totalScanned
  var emptyRatio = emptyRows / totalScanned
  var deepAvg = deepDarkTotal / totalScanned

  if (thickRatio > 0.3 && deepAvg > 3) return 'twall'
  if (thinLineRows >= 2 && thinRatio > 0.15 && deepAvg < 2) return 'window'
  if (gapLen <= 15 && emptyRatio < 0.8) return 'window'
  if (emptyRatio > 0.7) return 'open'
  if (deepAvg > 4) return 'twall'
  if (gapLen <= 20) return 'window'
  return 'open'
}


// ─── Outline description (for AI context) ────────────────────────────────────

function describeOutline(hWalls, vWalls, env, imgW, imgH) {
  if (!env) return { shape: 'unknown', description: 'Could not determine building envelope.' }

  // Find boundary walls at each edge
  var bTol = 15
  var topWalls = hWalls.filter(function (w) { return Math.abs(w.y1 - env.top) < bTol })
  var botWalls = hWalls.filter(function (w) { return Math.abs(w.y1 - env.bottom) < bTol })
  var leftWalls = vWalls.filter(function (w) { return Math.abs(w.x1 - env.left) < bTol })
  var rightWalls = vWalls.filter(function (w) { return Math.abs(w.x1 - env.right) < bTol })

  // Check if walls span full extent (rectangular) or partial (L/T/U shape)
  var envW = env.right - env.left
  var envH = env.bottom - env.top

  var topSpan = totalSpan(topWalls, 'h')
  var botSpan = totalSpan(botWalls, 'h')
  var leftSpan = totalSpan(leftWalls, 'v')
  var rightSpan = totalSpan(rightWalls, 'v')

  var topRatio = topSpan / envW
  var botRatio = botSpan / envW
  var leftRatio = leftSpan / envH
  var rightRatio = rightSpan / envH

  var isRect = topRatio > 0.85 && botRatio > 0.85 && leftRatio > 0.85 && rightRatio > 0.85

  if (isRect) {
    return {
      shape: 'rectangular',
      description: 'Building is approximately rectangular.',
      envWidth: envW, envHeight: envH
    }
  }

  // Non-rectangular — describe which sides are partial
  var partial = []
  if (topRatio < 0.85) partial.push('top wall spans only ' + Math.round(topRatio * 100) + '% of width')
  if (botRatio < 0.85) partial.push('bottom wall spans only ' + Math.round(botRatio * 100) + '% of width')
  if (leftRatio < 0.85) partial.push('left wall spans only ' + Math.round(leftRatio * 100) + '% of height')
  if (rightRatio < 0.85) partial.push('right wall spans only ' + Math.round(rightRatio * 100) + '% of height')

  // Determine L-shape direction
  var shape = 'L-shaped'
  if (partial.length >= 2 && (topRatio < 0.85 || botRatio < 0.85) && (leftRatio < 0.85 || rightRatio < 0.85)) {
    shape = 'L-shaped'
  }
  if (partial.length >= 3) shape = 'U-shaped or complex'

  return {
    shape: shape,
    description: 'Building is ' + shape + '. ' + partial.join('; ') + '.',
    envWidth: envW, envHeight: envH,
    topRatio: topRatio, botRatio: botRatio,
    leftRatio: leftRatio, rightRatio: rightRatio,
    topWallCount: topWalls.length, botWallCount: botWalls.length,
    leftWallCount: leftWalls.length, rightWallCount: rightWalls.length
  }
}

function totalSpan(walls, axis) {
  if (!walls.length) return 0
  var min = Infinity, max = -Infinity
  walls.forEach(function (w) {
    if (axis === 'h') { min = Math.min(min, w.x1); max = Math.max(max, w.x2) }
    else { min = Math.min(min, w.y1); max = Math.max(max, w.y2) }
  })
  return max - min
}


// ─── Classify all boundary gaps ──────────────────────────────────────────────

function classifyAllBoundaryGaps(hWalls, vWalls, env, bTol, mask, imgW, imgH) {
  var results = []
  if (!env) return results

  function processBoundary(walls, axis) {
    var pos = axis === 'h' ? 'y1' : 'x1'
    var boundaries = axis === 'h'
      ? [{ name: 'top', val: env.top }, { name: 'bottom', val: env.bottom }]
      : [{ name: 'left', val: env.left }, { name: 'right', val: env.right }]

    boundaries.forEach(function (b) {
      var segs = walls.filter(function (w) { return Math.abs(w[pos] - b.val) < bTol })
      if (segs.length < 2) return

      if (axis === 'h') segs.sort(function (a, c) { return a.x1 - c.x1 })
      else segs.sort(function (a, c) { return a.y1 - c.y1 })

      for (var i = 0; i < segs.length - 1; i++) {
        var gapStart = axis === 'h' ? segs[i].x2 : segs[i].y2
        var gapEnd = axis === 'h' ? segs[i + 1].x1 : segs[i + 1].y1
        var gapSize = gapEnd - gapStart
        if (gapSize < 3) continue

        var wallPos = Math.round(segs.reduce(function (s, w) { return s + w[pos] }, 0) / segs.length)
        var gapType = classifyGap(mask, imgW, imgH, wallPos, gapStart, gapEnd, axis)
        results.push({
          boundary: b.name, axis: axis,
          gapStart: gapStart, gapEnd: gapEnd,
          gapSize: gapSize, type: gapType
        })
      }
    })
  }

  processBoundary(hWalls, 'h')
  processBoundary(vWalls, 'v')
  return results
}


// ─── Join collinear — with T-wall check ──────────────────────────────────────

function joinCollinear(walls, axis, posTol, maxGap, mask, imgW, imgH) {
  if (walls.length < 2) return walls
  var sorted = walls.slice().sort(function (a, b) {
    return axis === 'h' ? a.y1 - b.y1 || a.x1 - b.x1 : a.x1 - b.x1 || a.y1 - b.y1
  })
  var result = [], cur = { x1: sorted[0].x1, y1: sorted[0].y1, x2: sorted[0].x2, y2: sorted[0].y2 }

  for (var i = 1; i < sorted.length; i++) {
    var s = sorted[i]
    var samePos = axis === 'h' ? Math.abs(s.y1 - cur.y1) <= posTol : Math.abs(s.x1 - cur.x1) <= posTol
    var gapStart = axis === 'h' ? cur.x2 : cur.y2
    var gapEnd = axis === 'h' ? s.x1 : s.y1
    var gapSize = gapEnd - gapStart
    var close = samePos && gapSize <= maxGap && gapSize >= 0

    if (close) {
      var shouldBridge = true
      if (mask && gapSize > 5) {
        var wallPos = axis === 'h' ? cur.y1 : cur.x1
        var gapType = classifyGap(mask, imgW, imgH, wallPos, gapStart, gapEnd, axis)
        if (gapType === 'twall') shouldBridge = false
      }
      if (shouldBridge) {
        if (axis === 'h') { cur.x1 = Math.min(cur.x1, s.x1); cur.x2 = Math.max(cur.x2, s.x2); cur.y1 = Math.round((cur.y1 + s.y1) / 2); cur.y2 = cur.y1 }
        else { cur.y1 = Math.min(cur.y1, s.y1); cur.y2 = Math.max(cur.y2, s.y2); cur.x1 = Math.round((cur.x1 + s.x1) / 2); cur.x2 = cur.x1 }
      } else { result.push(cur); cur = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 } }
    } else { result.push(cur); cur = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 } }
  }
  result.push(cur)
  return result
}


// ─── Window gap closing on boundary walls ────────────────────────────────────

function closeWindowGaps(walls, crossWalls, env, axis, bTol, mask, imgW, imgH) {
  var result = [], boundarySegs = []

  walls.forEach(function (w) {
    var pos = axis === 'h' ? w.y1 : w.x1
    var onB = false
    if (axis === 'h') onB = Math.abs(pos - env.top) < bTol || Math.abs(pos - env.bottom) < bTol
    else onB = Math.abs(pos - env.left) < bTol || Math.abs(pos - env.right) < bTol
    if (onB) boundarySegs.push(w); else result.push(w)
  })

  var groups = {}
  boundarySegs.forEach(function (w) {
    var pos = axis === 'h' ? w.y1 : w.x1
    var fk = null
    Object.keys(groups).forEach(function (k) { if (Math.abs(parseInt(k) - pos) <= bTol && !fk) fk = k })
    var key = fk || String(pos)
    if (!groups[key]) groups[key] = []
    groups[key].push(w)
  })

  Object.keys(groups).forEach(function (key) {
    var segs = groups[key]
    if (!segs.length) return
    var avgPos = 0
    segs.forEach(function (s) { avgPos += (axis === 'h' ? s.y1 : s.x1) })
    avgPos = Math.round(avgPos / segs.length)

    if (axis === 'h') {
      segs.sort(function (a, b) { return a.x1 - b.x1 })
      var merged = [{ x1: segs[0].x1, x2: segs[0].x2 }]
      for (var i = 1; i < segs.length; i++) {
        var last = merged[merged.length - 1], gs = last.x2, ge = segs[i].x1
        if (ge - gs <= 2) { last.x2 = Math.max(last.x2, segs[i].x2) }
        else {
          var gt = classifyGap(mask, imgW, imgH, avgPos, gs, ge, 'h')
          if (gt === 'window' || gt === 'noise') last.x2 = Math.max(last.x2, segs[i].x2)
          else merged.push({ x1: segs[i].x1, x2: segs[i].x2 })
        }
      }
      merged.forEach(function (m) { result.push({ x1: m.x1, y1: avgPos, x2: m.x2, y2: avgPos }) })
    } else {
      segs.sort(function (a, b) { return a.y1 - b.y1 })
      var merged2 = [{ y1: segs[0].y1, y2: segs[0].y2 }]
      for (var j = 1; j < segs.length; j++) {
        var last2 = merged2[merged2.length - 1], gs2 = last2.y2, ge2 = segs[j].y1
        if (ge2 - gs2 <= 2) { last2.y2 = Math.max(last2.y2, segs[j].y2) }
        else {
          var gt2 = classifyGap(mask, imgW, imgH, avgPos, gs2, ge2, 'v')
          if (gt2 === 'window' || gt2 === 'noise') last2.y2 = Math.max(last2.y2, segs[j].y2)
          else merged2.push({ y1: segs[j].y1, y2: segs[j].y2 })
        }
      }
      merged2.forEach(function (m) { result.push({ x1: avgPos, y1: m.y1, x2: avgPos, y2: m.y2 }) })
    }
  })
  return result
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function findEnvelope(h, v) {
  if (h.length < 2 || v.length < 2) return null
  var hs = h.slice().sort(function (a, b) { return a.y1 - b.y1 })
  var vs = v.slice().sort(function (a, b) { return a.x1 - b.x1 })
  return { top: hs[0].y1, bottom: hs[hs.length - 1].y1, left: vs[0].x1, right: vs[vs.length - 1].x1 }
}

function mergeSegments(segs, axis, tol) {
  if (!segs.length) return []
  var s = segs.slice().sort(function (a, b) { return axis === 'h' ? a.y1 - b.y1 || a.x1 - b.x1 : a.x1 - b.x1 || a.y1 - b.y1 })
  var m = [], c = { x1: s[0].x1, y1: s[0].y1, x2: s[0].x2, y2: s[0].y2 }
  for (var i = 1; i < s.length; i++) {
    var si = s[i]
    var sp = axis === 'h' ? Math.abs(si.y1 - c.y1) <= tol : Math.abs(si.x1 - c.x1) <= tol
    var ov = axis === 'h' ? si.x1 <= c.x2 + tol * 2 : si.y1 <= c.y2 + tol * 2
    if (sp && ov) {
      if (axis === 'h') { c.x1 = Math.min(c.x1, si.x1); c.x2 = Math.max(c.x2, si.x2); c.y1 = Math.round((c.y1 + si.y1) / 2); c.y2 = c.y1 }
      else { c.y1 = Math.min(c.y1, si.y1); c.y2 = Math.max(c.y2, si.y2); c.x1 = Math.round((c.x1 + si.x1) / 2); c.x2 = c.x1 }
    } else { m.push(c); c = { x1: si.x1, y1: si.y1, x2: si.x2, y2: si.y2 } }
  }
  m.push(c); return m
}

function filterOneEnd(walls, cross, axis, tol, minKeepLen) {
  return walls.filter(function (w) {
    var len = axis === 'h' ? (w.x2 - w.x1) : (w.y2 - w.y1)
    if (len >= minKeepLen) return true
    var connected = false
    cross.forEach(function (cw) {
      if (connected) return
      if (axis === 'h') { if (w.y1 >= cw.y1 - tol && w.y1 <= cw.y2 + tol && (Math.abs(cw.x1 - w.x1) < tol || Math.abs(cw.x1 - w.x2) < tol)) connected = true }
      else { if (w.x1 >= cw.x1 - tol && w.x1 <= cw.x2 + tol && (Math.abs(cw.y1 - w.y1) < tol || Math.abs(cw.y1 - w.y2) < tol)) connected = true }
    })
    return connected
  })
}

function filterBySolidity(walls, thickMap, imgWidth, minThick, minSolidity, axis) {
  return walls.filter(function (w) {
    var tc = 0, tot = 0
    if (axis === 'h') { for (var x = w.x1; x <= w.x2; x += 2) { tot++; var idx = w.y1 * imgWidth + x; if (idx >= 0 && idx < thickMap.length && thickMap[idx] >= minThick) tc++ } }
    else { for (var y = w.y1; y <= w.y2; y += 2) { tot++; var idx2 = y * imgWidth + w.x1; if (idx2 >= 0 && idx2 < thickMap.length && thickMap[idx2] >= minThick) tc++ } }
    return tot > 0 && (tc / tot) >= minSolidity
  })
}

function removeNearbyDuplicates(walls, axis, minDist) {
  if (walls.length < 2) return walls
  var sorted = walls.slice().sort(function (a, b) { return axis === 'h' ? a.y1 - b.y1 : a.x1 - b.x1 })
  var keep = sorted.map(function () { return true })
  for (var i = 0; i < sorted.length; i++) {
    if (!keep[i]) continue
    for (var j = i + 1; j < sorted.length; j++) {
      if (!keep[j]) continue
      var pA = axis === 'h' ? sorted[i].y1 : sorted[i].x1
      var pB = axis === 'h' ? sorted[j].y1 : sorted[j].x1
      if (Math.abs(pB - pA) > minDist) break
      var oS, oE, lA, lB
      if (axis === 'h') { oS = Math.max(sorted[i].x1, sorted[j].x1); oE = Math.min(sorted[i].x2, sorted[j].x2); lA = sorted[i].x2 - sorted[i].x1; lB = sorted[j].x2 - sorted[j].x1 }
      else { oS = Math.max(sorted[i].y1, sorted[j].y1); oE = Math.min(sorted[i].y2, sorted[j].y2); lA = sorted[i].y2 - sorted[i].y1; lB = sorted[j].y2 - sorted[j].y1 }
      if (oE - oS > Math.min(lA, lB) * 0.7) { if (lA >= lB) keep[j] = false; else { keep[i] = false; break } }
    }
  }
  return sorted.filter(function (w, idx) { return keep[idx] })
}
