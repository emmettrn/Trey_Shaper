"""
Starting-point designs. Values are typical, not copies of any specific shaper's model.
Rocker and thickness are given at the tip, 12" in from the tip, and (implicitly) the
low / thick point, the same stations a shaper measures.
"""

PRESETS: dict[str, dict] = {
    'Shortboard 6\'0"': dict(
        length=72, width=19.5, thickness=2.44, wide_point_offset=-1.0,
        nose_type='pointed', tail_type='squash',
        nose_width_12=12.0, tail_width_12=14.5, tail_block_width=10.0,
        nose_rocker=5.0, nose_rocker_12=2.1875, tail_rocker_12=0.8125, tail_rocker=2.2, rocker_low_point=-5,
        nose_thickness=0.85, nose_thickness_12=1.75, tail_thickness_12=1.875, tail_thickness=1.2,
        rail_apex=0.35, rail_fullness=0.45, rail_hardness_nose=0.25, rail_hardness_tail=0.85,
        concave_depth=0.12, vee_depth=0.0,
    ),
    'Fish 5\'6"': dict(
        length=66, width=21.0, thickness=2.55, wide_point_offset=-2.0,
        nose_type='round', tail_type='swallow',
        nose_width_12=15.5, tail_width_12=17.0, tail_block_width=13.0, swallow_depth=5.5, swallow_width=7.0,
        nose_rocker=3.6, nose_rocker_12=1.25, tail_rocker_12=0.5625, tail_rocker=1.4, rocker_low_point=-3,
        nose_thickness=1.0, nose_thickness_12=2.0625, tail_thickness_12=2.1875, tail_thickness=1.35,
        rail_apex=0.4, rail_fullness=0.7, rail_hardness_nose=0.2, rail_hardness_tail=0.8,
        concave_depth=0.08, vee_depth=0.05,
    ),
    'Groveler 5\'8"': dict(
        length=68, width=20.5, thickness=2.5, wide_point_offset=0.0,
        nose_type='semi_pointed', tail_type='squash',
        nose_width_12=14.0, tail_width_12=16.0, tail_block_width=11.5,
        nose_rocker=4.0, nose_rocker_12=1.5, tail_rocker_12=0.625, tail_rocker=1.6, rocker_low_point=-4,
        nose_thickness=0.95, nose_thickness_12=1.9375, tail_thickness_12=2.0625, tail_thickness=1.3,
        rail_apex=0.38, rail_fullness=0.65, rail_hardness_nose=0.25, rail_hardness_tail=0.9,
        concave_depth=0.15, vee_depth=0.0,
    ),
    'Mid-length 7\'6"': dict(
        length=90, width=21.0, thickness=2.75, wide_point_offset=1.0,
        nose_type='round', tail_type='rounded_pin',
        nose_width_12=15.0, tail_width_12=13.5,
        nose_rocker=4.5, nose_rocker_12=2.4375, tail_rocker_12=0.9375, tail_rocker=2.0, rocker_low_point=-6,
        nose_thickness=1.0, nose_thickness_12=1.875, tail_thickness_12=2.0, tail_thickness=1.3,
        rail_apex=0.45, rail_fullness=0.6, rail_hardness_nose=0.1, rail_hardness_tail=0.6,
        concave_depth=0.06, vee_depth=0.08,
    ),
    'Longboard 9\'2"': dict(
        length=110, width=23.0, thickness=3.0, wide_point_offset=2.0,
        nose_type='blunt', tail_type='square',
        nose_width_12=18.5, tail_width_12=15.0, tail_block_width=11.0,
        nose_rocker=4.2, nose_rocker_12=2.25, tail_rocker_12=1.3125, tail_rocker=2.4, rocker_low_point=-4,
        nose_thickness=1.2, nose_thickness_12=2.0, tail_thickness_12=2.1875, tail_thickness=1.5,
        rail_apex=0.5, rail_fullness=0.75, rail_hardness_nose=0.05, rail_hardness_tail=0.55,
        concave_depth=0.1, vee_depth=0.1,
    ),
    'Step-up 6\'8"': dict(
        length=80, width=19.0, thickness=2.6, wide_point_offset=1.0,
        nose_type='pointed', tail_type='pin',
        nose_width_12=11.5, tail_width_12=12.5,
        nose_rocker=5.6, nose_rocker_12=2.8125, tail_rocker_12=1.0625, tail_rocker=2.6, rocker_low_point=-6,
        nose_thickness=0.85, nose_thickness_12=1.75, tail_thickness_12=1.875, tail_thickness=1.15,
        rail_apex=0.32, rail_fullness=0.4, rail_hardness_nose=0.2, rail_hardness_tail=0.75,
        concave_depth=0.08, vee_depth=0.1,
    ),
    'Round pin 6\'0" (v3 example)': dict(   # the default board from surfboard_cad_v3.py
        length=72, width=19.0, thickness=2.375, wide_point_offset=0.0,
        nose_type='semi_pointed', tail_type='rounded_pin',
        nose_width_12=12.5, tail_width_12=14.5,
        nose_rocker=5.25, nose_rocker_12=1.75, tail_rocker_12=1.0, tail_rocker=2.375, rocker_low_point=0,
        nose_thickness=0.5, nose_thickness_12=1.625, tail_thickness_12=1.75, tail_thickness=0.5,
        rail_apex=0.42, rail_fullness=0.4, deck_dome=0.2, rail_hardness_nose=0.3, rail_hardness_tail=0.3,
        concave_depth=0.0, vee_depth=0.0,
    ),
}
