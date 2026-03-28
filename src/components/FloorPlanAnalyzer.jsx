/* CarpetPlan — FloorPlanAnalyzer Styles */

.fpa-root {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  color: #1f2937;
}

.fpa-header {
  margin-bottom: 2rem;
}

.fpa-header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 0.25rem;
}

.fpa-subtitle {
  color: #6b7280;
  font-size: 0.95rem;
  margin: 0;
}

/* Upload */
.fpa-upload {
  border: 2px dashed #d1d5db;
  border-radius: 12px;
  padding: 3rem 1.5rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: #f9fafb;
}

.fpa-upload:hover {
  border-color: #9ca3af;
  background: #f3f4f6;
}

.fpa-upload.drag {
  border-color: #3b82f6;
  background: #eff6ff;
}

.fpa-upload input { display: none; }

.fpa-upload-icon {
  display: block;
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.fpa-upload-text {
  color: #6b7280;
  font-size: 0.95rem;
}

/* Controls */
.fpa-controls {
  display: flex;
  gap: 1.5rem;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}

.fpa-preview {
  max-width: 280px;
  max-height: 220px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  object-fit: contain;
}

.fpa-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.fpa-btn {
  padding: 0.6rem 1.25rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}

.fpa-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.fpa-btn-primary {
  background: #2563eb;
  color: white;
}

.fpa-btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.fpa-btn-secondary {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
}

.fpa-btn-secondary:hover {
  background: #e5e7eb;
}

/* Error */
.fpa-error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

/* Loading */
.fpa-loading {
  text-align: center;
  padding: 2rem;
}

.fpa-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid #e5e7eb;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 1rem;
}

@keyframes spin { to { transform: rotate(360deg); } }

.fpa-loading p {
  color: #374151;
  font-size: 0.95rem;
  margin: 0;
}

.fpa-loading-sub {
  color: #9ca3af !important;
  font-size: 0.85rem !important;
  margin-top: 0.25rem !important;
}

/* Result */
.fpa-result {
  margin-top: 1.5rem;
}

.fpa-result-header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.fpa-result-header h2 {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
}

.fpa-result-stats {
  color: #6b7280;
  font-size: 0.85rem;
}

.fpa-canvas-wrap {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1rem;
  overflow: auto;
  margin-bottom: 1rem;
}

.fpa-canvas {
  display: block;
  max-width: 100%;
  height: auto;
}

/* Details / table */
.fpa-details {
  margin-bottom: 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

.fpa-details summary {
  padding: 0.6rem 1rem;
  cursor: pointer;
  font-weight: 500;
  font-size: 0.9rem;
  background: #f9fafb;
  user-select: none;
}

.fpa-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.fpa-table th, .fpa-table td {
  padding: 0.4rem 0.75rem;
  text-align: left;
  border-top: 1px solid #f3f4f6;
}

.fpa-table th {
  background: #f9fafb;
  font-weight: 600;
  color: #6b7280;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.fpa-json {
  margin: 0;
  padding: 1rem;
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-x: auto;
  background: #f9fafb;
  max-height: 400px;
}

/* Responsive */
@media (max-width: 640px) {
  .fpa-controls {
    flex-direction: column;
  }
  .fpa-preview {
    max-width: 100%;
  }
}
