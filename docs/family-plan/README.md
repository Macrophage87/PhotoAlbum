# Family plan document

`family-plan.tex` is the plain-language plan for the family, with TikZ diagrams and phone mockups.
Build it with a TeX Live that has TikZ and tcolorbox:

```bash
cd docs/family-plan
pdflatex family-plan.tex && pdflatex family-plan.tex
cp family-plan.pdf ../FAMILY-PLAN.pdf
```

Screenshots in `img/` were taken from the app at a phone viewport.
