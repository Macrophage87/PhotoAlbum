-- Detections the detector called CHICKEN were really just "a bird". Those nobody has confirmed become BIRD, so a
-- chicken flock is proposed for them only with evidence (#23). Confirmed ones are chickens a member agreed to and
-- stay CHICKEN. Proposals stand until the next matching pass for their photo looks at them again.
UPDATE "AnimalDetection" SET species = 'BIRD' WHERE species = 'CHICKEN' AND status <> 'CONFIRMED';
