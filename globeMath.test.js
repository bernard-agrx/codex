import { describe, it, expect } from 'vitest';
import {
  lonLatToWorld,
  worldToLonLat,
  clampLat,
  normalizeLon,
  TILE_SIZE,
} from './globeMath.js';

const approxEqual = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

describe('globe math helpers', () => {
  it('clamps latitude to ±85 degrees', () => {
    expect(clampLat(120)).toBe(85);
    expect(clampLat(-200)).toBe(-85);
    expect(clampLat(40)).toBe(40);
  });

  it('normalizes longitude to [-180, 180)', () => {
    expect(normalizeLon(200)).toBe(-160);
    expect(normalizeLon(-190)).toBe(170);
    expect(normalizeLon(45)).toBe(45);
  });

  it('converts lon/lat to world coords and back', () => {
    const samples = [
      { lon: 0, lat: 0, zoom: 2 },
      { lon: -74.006, lat: 40.7128, zoom: 3 },
      { lon: 139.6917, lat: 35.6895, zoom: 5 },
      { lon: 12.4964, lat: 41.9028, zoom: 8 },
    ];

    samples.forEach(({ lon, lat, zoom }) => {
      const world = lonLatToWorld(lon, lat, zoom);
      expect(world.x).toBeGreaterThanOrEqual(0);
      expect(world.y).toBeGreaterThanOrEqual(0);
      expect(world.x).toBeLessThanOrEqual(TILE_SIZE * Math.pow(2, zoom));
      expect(world.y).toBeLessThanOrEqual(TILE_SIZE * Math.pow(2, zoom));

      const restored = worldToLonLat(world.x, world.y, zoom);
      expect(approxEqual(restored.lon, lon, 1e-4)).toBe(true);
      expect(approxEqual(restored.lat, lat, 1e-4)).toBe(true);
    });
  });
});
