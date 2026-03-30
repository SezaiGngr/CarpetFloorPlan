import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

const LABEL_PROMPT = `Read ALL dimension labels from this floor plan image.

For each label, estimate its position as a fraction of the image (0-1):

Return JSON:
{
  "dimensions": [
    { "text": "3.7 x 3.7M", "x_frac": 0.2, "y_frac": 0.15, "width_m": 3.7, "height_m": 3.7 },
    { "text": "5.5 x 3.7M", "x_frac": 0.6, "y_frac": 0.15, "width_m": 5.5, "height_m": 3.7 }
  ]
}

- x_frac: 0=left, 1=right. y_frac: 0=top, 1=bottom.
- For "3.8 x 3.9M": width_m=3.8, height_m=3.9 (first=width, second=height)
- Skip non-dimension labels (BATH, VOID, FP etc)

Return ONLY valid JSON.`


// ─── WALL DETECTION ──────────────────────────────────────────────────────────

function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK = 105
  var MIN_LEN = 15
  var MIN_THICK = 4
  var MAX_GAP = 6
  var ROW_SKIP = 7
  var MERGE_TOL = 10
  var CONNECT_TOL = 25

  // Step 1: Dark pixel mask
  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  // Step 2: Vertical thickness map (for horizontal wall detection)
  var vThick = new Uint8Array(width * height)
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      if (!mask[y*width+x]) continue
      var t = 0
      for (var dy = -5; dy <= 5; dy++) {
        var ny = y+dy; if (ny>=0 && ny<height && mask[ny*width+x]) t++
      }
      vThick[y*width+x] = t
    }
  }

  // Step 3: Horizontal thickness map (for vertical wall detection)
  var hThick = new Uint8Array(width * height)
  for (var y2 = 0; y2 < height; y2++) {
    for (var x2 = 0; x2 < width; x2++) {
      if (!mask[y2*width+x2]) continue
      var t2 = 0
      for (var dx = -5; dx <= 5; dx++) {
        var nx = x2+dx; if (nx>=0 && nx<width && mask[y2*width+nx]) t2++
      }
      hThick[y2*width+x2] = t2
    }
  }

  // Step 4: Scan horizontal walls
  var hSegs = [], lastHY = -999
  for (var hy = 0; hy < height; hy++) {
    if (hy - lastHY < ROW_SKIP) continue
    var rs=-1, gap=0, found=false
    for (var hx = 0; hx < width; hx++) {
      if (vThick[hy*width+hx] >= MIN_THICK) { if(rs===-1)rs=hx; gap=0 }
      else if (rs!==-1) { gap++; if(gap>MAX_GAP){var e=hx-gap;if(e-rs>=MIN_LEN){hSegs.push({x1:rs,y1:hy,x2:e,y2:hy});found=true}rs=-1;gap=0} }
    }
    if(rs!==-1){var ex=width-1-gap;if(ex-rs>=MIN_LEN){hSegs.push({x1:rs,y1:hy,x2:ex,y2:hy});found=true}}
    if(found) lastHY=hy
  }

  // Step 5: Scan vertical walls
  var vSegs = [], lastVX = -999
  for (var vx = 0; vx < width; vx++) {
    if (vx - lastVX < ROW_SKIP) continue
    var rs2=-1, gap2=0, found2=false
    for (var vy = 0; vy < height; vy++) {
      if (hThick[vy*width+vx] >= MIN_THICK) { if(rs2===-1)rs2=vy; gap2=0 }
      else if (rs2!==-1) { gap2++; if(gap2>MAX_GAP){var e2=vy-gap2;if(e2-rs2>=MIN_LEN){vSegs.push({x1:vx,y1:rs2,x2:vx,y2:e2});found2=true}rs2=-1;gap2=0} }
    }
    if(rs2!==-1){var ey=height-1-gap2;if(ey-rs2>=MIN_LEN){vSegs.push({x1:vx,y1:rs2,x2:vx,y2:ey});found2=true}}
    if(found2) lastVX=vx
  }

  // Step 6: Merge nearby parallel segments
  var mH = mergeSegments(hSegs, 'h', MERGE_TOL)
  var mV = mergeSegments(vSegs, 'v', MERGE_TOL)

  // Step 7: Envelope filter
  var env = findEnvelope(mH, mV)
  if (env) {
    mH = mH.filter(function(w){return w.y1>=env.top-10&&w.y1<=env.bottom+10})
    mV = mV.filter(function(w){return w.x1>=env.left-10&&w.x1<=env.right+10})
  }

  // Step 8: Iterative connection filter (keeps long walls)
  var MIN_KEEP_LEN = 50
  mH = filterOneEnd(mH, mV, 'h', CONNECT_TOL, MIN_KEEP_LEN)
  mV = filterOneEnd(mV, mH, 'v', CONNECT_TOL, MIN_KEEP_LEN)
  mH = filterOneEnd(mH, mV, 'h', CONNECT_TOL, MIN_KEEP_LEN)

  // Step 9: Solidity filter
  mH = filterBySolidity(mH, vThick, width, MIN_THICK, 0.4, 'h')
  mV = filterBySolidity(mV, hThick, width, MIN_THICK, 0.4, 'v')

  // Step 10: Detect doors BEFORE joining
  var doors = detectDoors(mH, mV, mask, width, height, env)

  // Step 11: Join collinear segments
  mH = joinCollinear(mH, 'h', MERGE_TOL, 25)
  mV = joinCollinear(mV, 'v', MERGE_TOL, 25)

  // Step 12: Close window gaps — passes mask for pixel-level gap classification
  if (env) {
    mH = closeWindowGaps(mH, mV, env, 'h', 15, mask, width, height)
    mV = closeWindowGaps(mV, mH, env, 'v', 15, mask, width, height)
  }

  // Step 13: Remove near-duplicates
  mH = removeNearbyDuplicates(mH, 'h', 20)
  mV = removeNearbyDuplicates(mV, 'v', 20)

  return { horizontal: mH, vertical: mV, doors: doors, envelope: env }
}


// ─── GAP CLASSIFICATION: WINDOW vs T-WALL vs OPEN ───────────────────────────
//
// This is the core distinction the algorithm needs:
//
// WINDOW (bridge the gap):
//   - Thin parallel lines (1-2px) inside the gap
//   - Lines stay WITHIN the wall thickness band
//   - No dark pixels extending far beyond the wall
//   - Represents glass panes in floor plan notation
//
// T-WALL (don't bridge):
//   - Thick block of dark pixels (4-8px, same as wall thickness)
//   - Dark pixels extend FAR beyond the wall thickness band
//     (the perpendicular wall goes deep into the building)
//   - Represents a wall junction / building shape step-in
//
// OPEN GAP (don't bridge):
//   - Few or no dark pixels in the gap
//   - Represents actual opening in the building shape

function classifyGap(mask, imgW, imgH, wallPos, gapStart, gapEnd, axis) {
  var WALL_HALF = 8   // half of typical wall thickness (search band)
  var DEEP_SCAN = 25  // how far beyond wall band to check for T-wall

  var gapLen = gapEnd - gapStart
  if (gapLen < 3) return 'noise'  // trivially small, bridge it

  var thinLineRows = 0   // scan lines with thin dark pattern (window indicator)
  var thickRows = 0       // scan lines with thick dark pattern (wall indicator)
  var emptyRows = 0       // scan lines with no dark pixels
  var deepDarkTotal = 0   // dark pixels extending beyond wall band (T-wall indicator)
  var totalScanned = 0

  // Scan across the gap, one row/column at a time
  for (var g = gapStart + 1; g < gapEnd - 1; g++) {
    var nearDark = 0   // dark pixels within wall thickness band
    var deepDark = 0   // dark pixels extending beyond wall band

    if (axis === 'h') {
      // Horizontal wall at y=wallPos, gap runs along x from gapStart to gapEnd
      // Scan vertically at x=g across the wall thickness and beyond

      // Count dark pixels within wall band
      for (var dy = -WALL_HALF; dy <= WALL_HALF; dy++) {
        var sy = wallPos + dy
        if (sy >= 0 && sy < imgH && mask[sy * imgW + g]) nearDark++
      }
      // Count dark pixels extending beyond wall band (both sides)
      for (var dy2 = WALL_HALF + 1; dy2 <= WALL_HALF + DEEP_SCAN; dy2++) {
        var syUp = wallPos - dy2
        var syDown = wallPos + dy2
        if (syUp >= 0 && mask[syUp * imgW + g]) deepDark++
        if (syDown < imgH && mask[syDown * imgW + g]) deepDark++
      }
    } else {
      // Vertical wall at x=wallPos, gap runs along y from gapStart to gapEnd
      // Scan horizontally at y=g across the wall thickness and beyond

      for (var dx = -WALL_HALF; dx <= WALL_HALF; dx++) {
        var sx = wallPos + dx
        if (sx >= 0 && sx < imgW && mask[g * imgW + sx]) nearDark++
      }
      for (var dx2 = WALL_HALF + 1; dx2 <= WALL_HALF + DEEP_SCAN; dx2++) {
        var sxL = wallPos - dx2
        var sxR = wallPos + dx2
        if (sxL >= 0 && mask[g * imgW + sxL]) deepDark++
        if (sxR < imgW && mask[g * imgW + sxR]) deepDark++
      }
    }

    totalScanned++
    deepDarkTotal += deepDark

    if (nearDark === 0) {
      emptyRows++
    } else if (nearDark <= 4) {
      // Thin line: 1-4 dark pixels within wall band = window glass
      thinLineRows++
    } else {
      // Thick line: 5+ dark pixels = part of a wall
      thickRows++
    }
  }

  if (totalScanned === 0) return 'noise'

  var thinRatio = thinLineRows / totalScanned    // how much looks like window glass
  var thickRatio = thickRows / totalScanned       // how much looks like wall
  var emptyRatio = emptyRows / totalScanned       // how much is empty
  var deepAvg = deepDarkTotal / totalScanned      // avg deep pixels per scan line

  // Decision logic:
  //
  // T-WALL: many thick rows AND significant dark pixels extending deep
  // This means a perpendicular wall is crossing through the gap
  if (thickRatio > 0.3 && deepAvg > 3) return 'twall'

  // WINDOW: multiple thin lines, minimal deep extension
  // This means thin glass lines within the wall band only
  if (thinLineRows >= 2 && thinRatio > 0.15 && deepAvg < 2) return 'window'

  // Small gap with some content but ambiguous → likely window or noise
  if (gapLen <= 15 && emptyRatio < 0.8) return 'window'

  // Mostly empty gap → open space in building shape
  if (emptyRatio > 0.7) return 'open'

  // Lots of deep extension → probably T-wall even if near-wall is thin
  if (deepAvg > 4) return 'twall'

  // Default: some dark content but not clearly window or T-wall
  // If small enough, treat as bridgeable; otherwise leave open
  if (gapLen <= 20) return 'window'
  return 'open'
}


// ─── WINDOW GAP CLOSING (SHAPE-AGNOSTIC) ────────────────────────────────────
//
// For each gap in a boundary wall, uses classifyGap() to determine if
// the gap is a window (bridge) or a T-wall/open gap (don't bridge).
//
// This works for ANY building shape — rectangular, L, T, U, irregular.
// No assumption about straight boundary lines.

function closeWindowGaps(walls, crossWalls, env, axis, boundaryTol, mask, imgW, imgH) {
  var result = []
  var boundarySegs = []

  // Separate boundary walls from interior walls
  walls.forEach(function(w) {
    var pos = axis === 'h' ? w.y1 : w.x1
    var onBoundary = false
    if (axis === 'h') {
      onBoundary = Math.abs(pos - env.top) < boundaryTol ||
                   Math.abs(pos - env.bottom) < boundaryTol
    } else {
      onBoundary = Math.abs(pos - env.left) < boundaryTol ||
                   Math.abs(pos - env.right) < boundaryTol
    }
    if (onBoundary) boundarySegs.push(w)
    else result.push(w)
  })

  // Group boundary segments by position (same line within tolerance)
  var groups = {}
  boundarySegs.forEach(function(w) {
    var pos = axis === 'h' ? w.y1 : w.x1
    var foundKey = null
    Object.keys(groups).forEach(function(k) {
      if (Math.abs(parseInt(k) - pos) <= boundaryTol && !foundKey) foundKey = k
    })
    var key = foundKey || String(pos)
    if (!groups[key]) groups[key] = []
    groups[key].push(w)
  })

  // Process each boundary line
  Object.keys(groups).forEach(function(key) {
    var segs = groups[key]
    if (segs.length === 0) return

    // Average position for this boundary line
    var avgPos = 0
    segs.forEach(function(s) { avgPos += (axis === 'h' ? s.y1 : s.x1) })
    avgPos = Math.round(avgPos / segs.length)

    // Sort segments along the wall direction
    if (axis === 'h') {
      segs.sort(function(a, b) { return a.x1 - b.x1 })
    } else {
      segs.sort(function(a, b) { return a.y1 - b.y1 })
    }

    // Process gaps between consecutive segments
    if (axis === 'h') {
      var merged = [{x1: segs[0].x1, x2: segs[0].x2}]
      for (var i = 1; i < segs.length; i++) {
        var last = merged[merged.length - 1]
        var gapStart = last.x2
        var gapEnd = segs[i].x1
        var gapSize = gapEnd - gapStart

        if (gapSize <= 2) {
          // Trivial gap — always bridge
          last.x2 = Math.max(last.x2, segs[i].x2)
        } else {
          var gapType = classifyGap(mask, imgW, imgH, avgPos, gapStart, gapEnd, 'h')
          if (gapType === 'window' || gapType === 'noise') {
            last.x2 = Math.max(last.x2, segs[i].x2)
          } else {
            merged.push({x1: segs[i].x1, x2: segs[i].x2})
          }
        }
      }
      merged.forEach(function(m) {
        result.push({x1: m.x1, y1: avgPos, x2: m.x2, y2: avgPos})
      })

    } else {
      var merged2 = [{y1: segs[0].y1, y2: segs[0].y2}]
      for (var j = 1; j < segs.length; j++) {
        var last2 = merged2[merged2.length - 1]
        var gapStart2 = last2.y2
        var gapEnd2 = segs[j].y1
        var gapSize2 = gapEnd2 - gapStart2

        if (gapSize2 <= 2) {
          last2.y2 = Math.max(last2.y2, segs[j].y2)
        } else {
          var gapType2 = classifyGap(mask, imgW, imgH, avgPos, gapStart2, gapEnd2, 'v')
          if (gapType2 === 'window' || gapType2 === 'noise') {
            last2.y2 = Math.max(last2.y2, segs[j].y2)
          } else {
            merged2.push({y1: segs[j].y1, y2: segs[j].y2})
          }
        }
      }
      merged2.forEach(function(m) {
        result.push({x1: avgPos, y1: m.y1, x2: avgPos, y2: m.y2})
      })
    }
  })

  return result
}


// ─── DOOR DETECTION ──────────────────────────────────────────────────────────

function detectDoors(hWalls, vWalls, mask, imgW, imgH, env) {
  var doors = []
  var boundaryTol = 15

  var hByY = groupByPos(hWalls, 'h', 10)
  Object.keys(hByY).forEach(function(key) {
    var segs = hByY[key].sort(function(a,b){return a.x1-b.x1})
    for (var i = 0; i < segs.length - 1; i++) {
      var gapStart = segs[i].x2
      var gapEnd = segs[i+1].x1
      var gapSize = gapEnd - gapStart
      var wallY = segs[i].y1
      if (env && (Math.abs(wallY - env.top) < boundaryTol || Math.abs(wallY - env.bottom) < boundaryTol)) continue
      if (gapSize > 10 && gapSize < 80) {
        var hasArc = checkForArc(mask, imgW, imgH, gapStart, wallY, gapEnd, wallY, gapSize)
        if (hasArc || gapSize > 15) {
          doors.push({ x: gapStart, y: wallY, width: gapSize, orientation: 'horizontal', hasArc: hasArc })
        }
      }
    }
  })

  var vByX = groupByPos(vWalls, 'v', 10)
  Object.keys(vByX).forEach(function(key) {
    var segs = vByX[key].sort(function(a,b){return a.y1-b.y1})
    for (var i = 0; i < segs.length - 1; i++) {
      var gapStart = segs[i].y2
      var gapEnd = segs[i+1].y1
      var gapSize = gapEnd - gapStart
      var wallX = segs[i].x1
      if (env && (Math.abs(wallX - env.left) < boundaryTol || Math.abs(wallX - env.right) < boundaryTol)) continue
      if (gapSize > 10 && gapSize < 80) {
        var hasArc = checkForArc(mask, imgW, imgH, wallX, gapStart, wallX, gapEnd, gapSize)
        if (hasArc || gapSize > 15) {
          doors.push({ x: wallX, y: gapStart, width: gapSize, orientation: 'vertical', hasArc: hasArc })
        }
      }
    }
  })

  return doors
}

function groupByPos(walls, axis, tol) {
  var groups = {}
  walls.forEach(function(w) {
    var pos = axis === 'h' ? w.y1 : w.x1
    var key = Math.round(pos / tol) * tol
    if (!groups[key]) groups[key] = []
    groups[key].push(w)
  })
  return groups
}

function checkForArc(mask, imgW, imgH, x1, y1, x2, y2, gapSize) {
  var radius = gapSize
  var cx, cy, darkCount = 0, totalChecked = 0
  if (y1 === y2) {
    cx = x1; cy = y1
    for (var angle = 0; angle < 90; angle += 5) {
      var rad = angle * Math.PI / 180
      var px = Math.round(cx + radius * Math.cos(rad))
      var py = Math.round(cy + radius * Math.sin(rad))
      if (px >= 0 && px < imgW && py >= 0 && py < imgH) { totalChecked++; if (mask[py * imgW + px]) darkCount++ }
      py = Math.round(cy - radius * Math.sin(rad))
      if (px >= 0 && px < imgW && py >= 0 && py < imgH) { totalChecked++; if (mask[py * imgW + px]) darkCount++ }
    }
  } else {
    cx = x1; cy = y1
    for (var angle2 = 0; angle2 < 90; angle2 += 5) {
      var rad2 = angle2 * Math.PI / 180
      var px2 = Math.round(cx + radius * Math.cos(rad2))
      var py2 = Math.round(cy + radius * Math.sin(rad2))
      if (px2 >= 0 && px2 < imgW && py2 >= 0 && py2 < imgH) { totalChecked++; if (mask[py2 * imgW + px2]) darkCount++ }
      px2 = Math.round(cx - radius * Math.cos(rad2))
      if (px2 >= 0 && px2 < imgW && py2 >= 0 && py2 < imgH) { totalChecked++; if (mask[py2 * imgW + px2]) darkCount++ }
    }
  }
  return totalChecked > 0 && (darkCount / totalChecked) > 0.15
}


// ─── CONNECTION FILTER (iterative, keeps long walls) ─────────────────────────

function filterOneEnd(walls, cross, axis, tol, minKeepLen) {
  return walls.filter(function(w) {
    var len = axis === 'h' ? (w.x2 - w.x1) : (w.y2 - w.y1)
    if (len >= minKeepLen) return true
    var connected = false
    cross.forEach(function(cw) {
      if (connected) return
      if (axis === 'h') {
        if (w.y1 >= cw.y1-tol && w.y1 <= cw.y2+tol) {
          if (Math.abs(cw.x1-w.x1)<tol || Math.abs(cw.x1-w.x2)<tol) connected = true
        }
      } else {
        if (w.x1 >= cw.x1-tol && w.x1 <= cw.x2+tol) {
          if (Math.abs(cw.y1-w.y1)<tol || Math.abs(cw.y1-w.y2)<tol) connected = true
        }
      }
    })
    return connected
  })
}

function filterBySolidity(walls, thickMap, imgWidth, minThick, minSolidity, axis) {
  return walls.filter(function(w) {
    var thickCount = 0, totalCount = 0
    if (axis === 'h') {
      for (var x = w.x1; x <= w.x2; x += 2) {
        totalCount++
        var idx = w.y1 * imgWidth + x
        if (idx >= 0 && idx < thickMap.length && thickMap[idx] >= minThick) thickCount++
      }
    } else {
      for (var y = w.y1; y <= w.y2; y += 2) {
        totalCount++
        var idx2 = y * imgWidth + w.x1
        if (idx2 >= 0 && idx2 < thickMap.length && thickMap[idx2] >= minThick) thickCount++
      }
    }
    if (totalCount === 0) return false
    return (thickCount / totalCount) >= minSolidity
  })
}


// ─── NEAR-DUPLICATE REMOVAL (stricter 70% overlap) ──────────────────────────

function removeNearbyDuplicates(walls, axis, minDist) {
  if (walls.length < 2) return walls
  var sorted = walls.slice().sort(function(a, b) {
    return axis === 'h' ? a.y1 - b.y1 : a.x1 - b.x1
  })
  var keep = []
  for (var i = 0; i < sorted.length; i++) keep.push(true)
  for (var i = 0; i < sorted.length; i++) {
    if (!keep[i]) continue
    for (var j = i + 1; j < sorted.length; j++) {
      if (!keep[j]) continue
      var posA = axis === 'h' ? sorted[i].y1 : sorted[i].x1
      var posB = axis === 'h' ? sorted[j].y1 : sorted[j].x1
      if (Math.abs(posB - posA) > minDist) break
      var oStart, oEnd, lenA, lenB
      if (axis === 'h') {
        oStart = Math.max(sorted[i].x1, sorted[j].x1)
        oEnd = Math.min(sorted[i].x2, sorted[j].x2)
        lenA = sorted[i].x2 - sorted[i].x1
        lenB = sorted[j].x2 - sorted[j].x1
      } else {
        oStart = Math.max(sorted[i].y1, sorted[j].y1)
        oEnd = Math.min(sorted[i].y2, sorted[j].y2)
        lenA = sorted[i].y2 - sorted[i].y1
        lenB = sorted[j].y2 - sorted[j].y1
      }
      if (oEnd - oStart > Math.min(lenA, lenB) * 0.7) {
        if (lenA >= lenB) keep[j] = false
        else { keep[i] = false; break }
      }
    }
  }
  return sorted.filter(function(w, idx) { return keep[idx] })
}

function findEnvelope(h, v) {
  if(h.length<2||v.length<2)return null
  var hs=h.slice().sort(function(a,b){return a.y1-b.y1})
  var vs=v.slice().sort(function(a,b){return a.x1-b.x1})
  return{top:hs[0].y1,bottom:hs[hs.length-1].y1,left:vs[0].x1,right:vs[vs.length-1].x1}
}

function mergeSegments(segs, axis, tol) {
  if(!segs.length)return[]
  var s=segs.slice().sort(function(a,b){return axis==='h'?a.y1-b.y1||a.x1-b.x1:a.x1-b.x1||a.y1-b.y1})
  var m=[],c={x1:s[0].x1,y1:s[0].y1,x2:s[0].x2,y2:s[0].y2}
  for(var i=1;i<s.length;i++){
    var si=s[i],sp=axis==='h'?Math.abs(si.y1-c.y1)<=tol:Math.abs(si.x1-c.x1)<=tol
    var ov=axis==='h'?si.x1<=c.x2+tol*2:si.y1<=c.y2+tol*2
    if(sp&&ov){if(axis==='h'){c.x1=Math.min(c.x1,si.x1);c.x2=Math.max(c.x2,si.x2);c.y1=Math.round((c.y1+si.y1)/2);c.y2=c.y1}
    else{c.y1=Math.min(c.y1,si.y1);c.y2=Math.max(c.y2,si.y2);c.x1=Math.round((c.x1+si.x1)/2);c.x2=c.x1}}
    else{m.push(c);c={x1:si.x1,y1:si.y1,x2:si.x2,y2:si.y2}}
  }
  m.push(c);return m
}

function joinCollinear(walls, axis, posTol, maxGap) {
  if(walls.length<2)return walls
  var sorted=walls.slice().sort(function(a,b){return axis==='h'?a.y1-b.y1||a.x1-b.x1:a.x1-b.x1||a.y1-b.y1})
  var result=[],cur={x1:sorted[0].x1,y1:sorted[0].y1,x2:sorted[0].x2,y2:sorted[0].y2}
  for(var i=1;i<sorted.length;i++){
    var s=sorted[i]
    var samePos=axis==='h'?Math.abs(s.y1-cur.y1)<=posTol:Math.abs(s.x1-cur.x1)<=posTol
    var close=false
    if(samePos){close=axis==='h'?s.x1<=cur.x2+maxGap:s.y1<=cur.y2+maxGap}
    if(samePos&&close){
      if(axis==='h'){cur.x1=Math.min(cur.x1,s.x1);cur.x2=Math.max(cur.x2,s.x2);cur.y1=Math.round((cur.y1+s.y1)/2);cur.y2=cur.y1}
      else{cur.y1=Math.min(cur.y1,s.y1);cur.y2=Math.max(cur.y2,s.y2);cur.x1=Math.round((cur.x1+s.x1)/2);cur.x2=cur.x1}
    }else{result.push(cur);cur={x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2}}
  }
  result.push(cur);return result
}


// ─── ROOM + PPM ──────────────────────────────────────────────────────────────

function detectRooms(hW, vW, tol) {
  tol = tol || 20
  var yPos=[], xPos=[]
  hW.forEach(function(w){var f=false;for(var i=0;i<yPos.length;i++){if(Math.abs(yPos[i]-w.y1)<tol){f=true;break}}if(!f)yPos.push(w.y1)})
  vW.forEach(function(w){var f=false;for(var i=0;i<xPos.length;i++){if(Math.abs(xPos[i]-w.x1)<tol){f=true;break}}if(!f)xPos.push(w.x1)})
  yPos.sort(function(a,b){return a-b});xPos.sort(function(a,b){return a-b})
  var rooms=[]
  for(var yi=0;yi<yPos.length-1;yi++){for(var xi=0;xi<xPos.length-1;xi++){
    var t=yPos[yi],b=yPos[yi+1],l=xPos[xi],r=xPos[xi+1]
    if(r-l<30||b-t<30)continue
    var sides=0
    if(hasH(hW,t,l,r,tol))sides++;if(hasH(hW,b,l,r,tol))sides++
    if(hasV(vW,l,t,b,tol))sides++;if(hasV(vW,r,t,b,tol))sides++
    if(sides>=3)rooms.push({left:l,top:t,right:r,bottom:b,widthPx:r-l,heightPx:b-t,cx:(l+r)/2,cy:(t+b)/2})
  }}
  return rooms
}
function hasH(ws,y,x1,x2,t){for(var i=0;i<ws.length;i++){var w=ws[i];if(Math.abs(w.y1-y)<t&&Math.min(w.x2,x2)-Math.max(w.x1,x1)>(x2-x1)*0.3)return true}return false}
function hasV(ws,x,y1,y2,t){for(var i=0;i<ws.length;i++){var w=ws[i];if(Math.abs(w.x1-x)<t&&Math.min(w.y2,y2)-Math.max(w.y1,y1)>(y2-y1)*0.3)return true}return false}

function matchPPM(rooms,dims,imgW,imgH){
  var ppms=[]
  ;(dims||[]).forEach(function(dim){
    if(!dim.width_m||!dim.height_m||dim.x_frac==null)return
    var lx=dim.x_frac*imgW,ly=dim.y_frac*imgH,best=null,bd=Infinity
    rooms.forEach(function(r){if(lx>=r.left-30&&lx<=r.right+30&&ly>=r.top-30&&ly<=r.bottom+30){var d=Math.sqrt(Math.pow(lx-r.cx,2)+Math.pow(ly-r.cy,2));if(d<bd){bd=d;best=r}}})
    if(!best){rooms.forEach(function(r){var d=Math.sqrt(Math.pow(lx-r.cx,2)+Math.pow(ly-r.cy,2));if(d<bd){bd=d;best=r}})}
    if(best&&dim.width_m>0&&dim.height_m>0){
      var px=best.widthPx/dim.width_m,py=best.heightPx/dim.height_m
      if(px>10&&px<200)ppms.push(px);if(py>10&&py<200)ppms.push(py)
      best.matchedDim=dim;best.ppmX=px;best.ppmY=py
    }
  })
  if(!ppms.length)return null
  ppms.sort(function(a,b){return a-b})
  var med=ppms[Math.floor(ppms.length/2)]
  var filt=ppms.filter(function(v){return Math.abs(v-med)/med<0.2})
  if(!filt.length)filt=[med]
  var sum=0;filt.forEach(function(v){sum+=v});return sum/filt.length
}


// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function FloorPlanAnalyzer() {
  const [image,setImage]=useState(null)
  const [analysis,setAnalysis]=useState(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState(null)
  const canvasRef=useRef(null),fileRef=useRef(null),imgElRef=useRef(null)

  var handleFile=useCallback(function(file){
    if(!file||!file.type||!file.type.startsWith('image/'))return
    setError(null);setAnalysis(null)
    var reader=new FileReader()
    reader.onload=function(e){var img=new Image();img.onload=function(){
      var scale=img.width>MAX_IMG_WIDTH?MAX_IMG_WIDTH/img.width:1
      var c=document.createElement('canvas');c.width=img.width*scale;c.height=img.height*scale
      c.getContext('2d').drawImage(img,0,0,c.width,c.height)
      setImage(c.toDataURL('image/png'));imgElRef.current={canvas:c,width:c.width,height:c.height}
    };img.src=e.target.result};reader.readAsDataURL(file)
  },[])

  var onDrop=useCallback(function(e){e.preventDefault();e.currentTarget.classList.remove('drag');handleFile(e.dataTransfer.files[0])},[handleFile])

  var analyze=async function(){
    if(!imgElRef.current)return;setLoading(true);setError(null);setAnalysis(null)
    try{
      var ic=imgElRef.current.canvas,w=ic.width,h=ic.height
      var pd=ic.getContext('2d').getImageData(0,0,w,h)
      var wd=detectWalls(pd,w,h)
      var rooms=detectRooms(wd.horizontal,wd.vertical)

      var aiData=null,ppm=null
      try{
        var apiKey=import.meta.env.VITE_ANTHROPIC_API_KEY
        if(apiKey){
          var b64=ic.toDataURL('image/jpeg',0.85).split(',')[1]
          var resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
            headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body:JSON.stringify({model:MODEL,max_tokens:2048,messages:[{role:'user',content:[
              {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},{type:'text',text:LABEL_PROMPT}]}]})})
          if(resp.ok){var data=await resp.json();var txt='';data.content.forEach(function(b){txt+=(b.text||'')})
            aiData=JSON.parse(txt.replace(/```json/g,'').replace(/```/g,'').trim())}
        }
      }catch(e2){console.warn('AI err:',e2)}

      if(aiData&&aiData.dimensions)ppm=matchPPM(rooms,aiData.dimensions,w,h)
      if(!ppm){var all=wd.horizontal.concat(wd.vertical);var mnX=Infinity,mxX=-Infinity
        all.forEach(function(wl){mnX=Math.min(mnX,wl.x1,wl.x2);mxX=Math.max(mxX,wl.x1,wl.x2)});ppm=(mxX-mnX)/10}

      setAnalysis({walls:wd.horizontal.concat(wd.vertical),hWalls:wd.horizontal,vWalls:wd.vertical,
        hCount:wd.horizontal.length,vCount:wd.vertical.length,doors:wd.doors||[],
        rooms:rooms,ppm:ppm,aiData:aiData,imgWidth:w,imgHeight:h})
    }catch(err){setError(err.message)}finally{setLoading(false)}
  }

  useEffect(function(){if(analysis&&analysis.walls&&analysis.walls.length>0)drawFloorPlan()},[analysis])

  var drawFloorPlan=function(){
    var canvas=canvasRef.current;if(!canvas||!analysis)return
    var allW=(analysis.hWalls||[]).concat(analysis.vWalls||[]);if(!allW.length)return
    var srcW=analysis.imgWidth,srcH=analysis.imgHeight,ppm=analysis.ppm||80
    var PAD=70,scale=Math.min((900-PAD*2)/srcW,(800-PAD*2)/srcH,1)
    var cw=srcW*scale+PAD*2,ch=srcH*scale+PAD*2
    canvas.width=cw;canvas.height=ch
    var ctx=canvas.getContext('2d');ctx.clearRect(0,0,cw,ch);ctx.fillStyle='#fff';ctx.fillRect(0,0,cw,ch)
    var X=function(p){return PAD+p*scale},Y=function(p){return PAD+p*scale},S=function(p){return p*scale}

    ctx.strokeStyle='#1a1a1a';ctx.lineWidth=Math.max(2.5,4*scale);ctx.lineCap='square'
    allW.forEach(function(w){ctx.beginPath();ctx.moveTo(X(w.x1),Y(w.y1));ctx.lineTo(X(w.x2),Y(w.y2));ctx.stroke()})

    ctx.strokeStyle='#6B7280';ctx.lineWidth=1.5
    ;(analysis.doors||[]).forEach(function(d){
      var dwPx=S(d.width)
      if(d.orientation==='horizontal'){
        ctx.beginPath();ctx.arc(X(d.x),Y(d.y),dwPx,0,Math.PI/2,false);ctx.stroke()
        ctx.beginPath();ctx.moveTo(X(d.x),Y(d.y));ctx.lineTo(X(d.x),Y(d.y)+dwPx);ctx.stroke()
      }else{
        ctx.beginPath();ctx.arc(X(d.x),Y(d.y),dwPx,0,Math.PI/2,false);ctx.stroke()
        ctx.beginPath();ctx.moveTo(X(d.x),Y(d.y));ctx.lineTo(X(d.x)+dwPx,Y(d.y));ctx.stroke()
      }
    })

    ctx.fillStyle='#2563eb'
    allW.forEach(function(w){
      var dx=w.x2-w.x1,dy=w.y2-w.y1,lp=Math.sqrt(dx*dx+dy*dy),sl=lp*scale
      if(sl<35)return
      var lb=(lp/ppm).toFixed(2)+'m',fs=Math.max(8,Math.min(11,sl/8))
      ctx.font=fs+'px "Segoe UI",system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle'
      var mx=X((w.x1+w.x2)/2),my=Y((w.y1+w.y2)/2)
      if(Math.abs(dy)<2){ctx.fillText(lb,mx,my-10)}
      else{ctx.save();ctx.translate(mx-10,my);ctx.rotate(-Math.PI/2);ctx.fillText(lb,0,0);ctx.restore()}
    })

    ctx.fillStyle='#9ca3af';ctx.font='11px sans-serif';ctx.textAlign='right';ctx.textBaseline='top';ctx.fillText('N \u2191',cw-8,8)
    var matched=(analysis.rooms||[]).filter(function(r){return r.matchedDim}).length
    ctx.fillStyle='#6b7280';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom'
    ctx.fillText(analysis.hCount+'H+'+analysis.vCount+'V | '+matched+' matched | '+(analysis.doors||[]).length+' doors | ppm='+(ppm||0).toFixed(1),PAD,ch-8)
  }

  return (
    <div className="fpa-root">
      <header className="fpa-header"><h1>CarpetPlan</h1><p className="fpa-subtitle">Upload a floor plan &rarr; Detect walls, doors &amp; dimensions</p></header>
      {!image&&(<div className="fpa-upload" onClick={function(){fileRef.current&&fileRef.current.click()}} onDrop={onDrop}
        onDragOver={function(e){e.preventDefault();e.currentTarget.classList.add('drag')}} onDragLeave={function(e){e.currentTarget.classList.remove('drag')}}>
        <input ref={fileRef} type="file" accept="image/*" onChange={function(e){handleFile(e.target.files[0])}}/>
        <span className="fpa-upload-icon">&#x1F4D0;</span><span className="fpa-upload-text">Drop floor plan or click to browse</span></div>)}
      {image&&(<div className="fpa-controls"><img src={image} alt="" className="fpa-preview"/>
        <div className="fpa-buttons">
          <button onClick={analyze} disabled={loading} className="fpa-btn fpa-btn-primary">{loading?'Processing\u2026':'Detect Walls'}</button>
          <button onClick={function(){setImage(null);setAnalysis(null);setError(null);imgElRef.current=null}} className="fpa-btn fpa-btn-secondary">Clear</button>
        </div></div>)}
      {error&&<div className="fpa-error">{error}</div>}
      {loading&&<div className="fpa-loading"><div className="fpa-spinner"/><p>Processing&hellip;</p></div>}
      {analysis&&(<div className="fpa-result">
        <div className="fpa-result-header"><h2>Detected Floor Plan</h2>
          <div className="fpa-result-stats">{analysis.hCount}H&middot;{analysis.vCount}V walls &middot; {(analysis.doors||[]).length} doors</div></div>
        <div className="fpa-canvas-wrap"><canvas ref={canvasRef} className="fpa-canvas"/></div>
        <details className="fpa-details"><summary>Data</summary>
          <pre className="fpa-json">{JSON.stringify({ppm:analysis.ppm,rooms:(analysis.rooms||[]).length,doors:(analysis.doors||[]).length,
            matched:(analysis.rooms||[]).filter(function(r){return r.matchedDim}).map(function(r){return{dim:r.matchedDim.text,ppmX:Math.round((r.ppmX||0)*10)/10,ppmY:Math.round((r.ppmY||0)*10)/10}}),
            aiDims:analysis.aiData?analysis.aiData.dimensions:null},null,2)}</pre></details>
      </div>)}
    </div>
  )
}
