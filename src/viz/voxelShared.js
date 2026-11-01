/** Shared voxel-AO strength uniform (0 = off, 1 = full); read by every voxel material. */
export const aoUniform = { value: 1 };

/** Visible-instance counts above which cheaper cube meshes are used (300 ? ~100 ? 12 triangles). */
export const LOD_THRESHOLDS = Object.freeze({ rounded2: 15000, rounded1: 60000 });
