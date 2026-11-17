-- Starter folders. Upload each photo to R2 at the image_key path.
-- Songs and Prayer folders are examples: replace with your own artists / leaders.
INSERT OR REPLACE INTO speakers (id, category, name, image_key, glow, sort) VALUES
 ('selman',   'mog', 'Apostle Joshua Selman',  'speakers/selman.jpg',   '#FFC107', 1),
 ('oyedepo',  'mog', 'Bishop David Oyedepo',   'speakers/oyedepo.jpg',  '#00E5FF', 2),
 ('abioye',   'mog', 'Bishop David Abioye',    'speakers/abioye.jpg',   '#FF4081', 3),
 ('adeboye',  'mog', 'Pastor E.A. Adeboye',    'speakers/adeboye.jpg',  '#69F0AE', 4),
 ('lubega',   'mog', 'Apostle Grace Lubega',   'speakers/lubega.jpg',   '#B388FF', 5),
 ('kyula',    'mog', 'Rev Julian Kyula',       'speakers/kyula.jpg',    '#FF6E40', 6),

 ('songs-1',  'songs',  'Worship Collection 1', 'speakers/songs-1.jpg',  '#40C4FF', 1),
 ('songs-2',  'songs',  'Worship Collection 2', 'speakers/songs-2.jpg',  '#EEFF41', 2),

 ('prayer-1', 'prayer', 'Morning Prayers',      'speakers/prayer-1.jpg', '#FF80AB', 1),
 ('prayer-2', 'prayer', 'Night Prayers',        'speakers/prayer-2.jpg', '#84FFFF', 2);
