
# PPE Annotation Policy v1

## Class Mapping

| ID | Class       |
| -- | ----------- |
| 0  | Gloves      |
| 1  | Vest        |
| 2  | goggles     |
| 3  | helmet      |
| 4  | mask        |
| 5  | safety_shoe |

## General rule

The detector identifies visible PPE objects.

Correct/incorrect PPE usage is NOT encoded directly in these
six object classes. Compliance will be evaluated later using
person-PPE spatial relationships and safety rules.

## Gloves

Include:

- protective work gloves

Exclude:

- bare hands
- fashion gloves
- ambiguous objects

Annotate individual gloves separately when clearly visible.

## Vest

Include:

- safety vest
- reflective vest
- high-visibility work vest

Exclude:

- normal clothing
- fashion vest

## goggles

Include:

- safety goggles
- protective industrial eyewear

Exclude:

- normal prescription glasses
- fashion sunglasses

The bounding box must surround the actual goggles location.

## helmet

Include:

- hard hats
- industrial safety helmets

Exclude:

- caps
- fashion hats

## mask

Include:

- protective masks
- medical masks
- respirators

Exclude:

- scarves
- hands covering the face
- ambiguous face regions

## safety_shoe

Include:

- safety shoes
- industrial work boots
- protective footwear

Exclude:

- normal sneakers
- sandals
- fashion shoes

Annotate individual shoes separately when possible.

## Bounding-box policy

- Boxes must tightly surround the visible PPE object.
- Do not annotate body regions instead of the PPE object.
- Boxes must remain inside image boundaries.
- Partial/occluded PPE can be annotated when identifiable.
- Do not hallucinate objects that cannot be clearly identified.

## Multi-PPE images

Every visible target PPE instance must be annotated.

Example:
1 helmet + 1 vest + 1 mask + 2 gloves
= 5 bounding boxes.

## Negative images

An image with no target PPE is a valid negative/background image.

An empty label file is therefore not automatically an annotation error.
It must first be visually reviewed.
