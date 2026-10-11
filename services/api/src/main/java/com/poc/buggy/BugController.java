package com.poc.buggy;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "http://localhost:5173")
public class BugController {

    @GetMapping("/calculate")
    public Object calculate(@RequestParam(defaultValue = "0") int divisor) {
        if (divisor == 0) {
            return "Cannot divide by zero";
        }
        int x = 100 / divisor;
        return x;
    }
}
