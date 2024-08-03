import pkg_resources
import utils as U


def load_prompt(prompt):
    return U.load_text(f"shannon/prompts/{prompt}.txt")
